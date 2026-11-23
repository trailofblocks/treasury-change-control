import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { chainReader } from "./chain.mjs";
import {
  actorFor, demoKeys, DeskError, expect, fields, hash, LOCAL_CHAIN, prepare, revisionRef, transferTx,
} from "./treasury.mjs";

const assets = {
  "/": ["text/html; charset=utf-8", "index.html"],
  "/app.js": ["text/javascript; charset=utf-8", "app.js"],
  "/styles.css": ["text/css; charset=utf-8", "styles.css"],
};

function json(response, code, body, extra = {}) {
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...extra });
  response.end(JSON.stringify(body));
}

async function body(request) {
  expect(/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""), 415, "Use application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    expect(size <= 16_384, 413, "The proposal is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new DeskError(400, "Malformed JSON."); }
}

function status(proposal, config) {
  if (proposal.execution) return "executed";
  if (proposal.current.policyHash !== config.policyHash) return "stale_policy";
  if (!proposal.current.review.allowed) return "blocked";
  return proposal.approval ? "approved" : "in_review";
}

function candidate(input, config) {
  if (input && Object.hasOwn(input, "transfer")) {
    fields(input, ["title", "transfer"]);
    const q = input.transfer;
    fields(q, ["token", "recipient", "amount", "nonce"]);
    return prepare({ title: input.title, tx: transferTx(config, q.token, q.recipient, q.amount, q.nonce) }, config);
  }
  return prepare(input, config);
}

export function createDesk({ store, config, keys, demo = false, chain = chainReader(config) }) {
  expect(!demo || config.chainId === LOCAL_CHAIN, 400, "Demo sessions require the local test chain.");
  const publicConfig = {
    demo, chainId: config.chainId, safe: config.safe,
    tokens: config.tokens, policyHash: config.policyHash, confirmations: config.confirmations,
  };
  const view = proposal => ({ ...proposal, status: status(proposal, config) });

  const server = createServer({ requestTimeout: 20_000, headersTimeout: 8_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(request.url, "http://treasury.local").pathname;
      const method = request.method;
      if (method === "GET" && Object.hasOwn(assets, path)) {
        const [type, file] = assets[path];
        const content = readFileSync(new URL(`../web/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": type });
        response.end(content);
        return;
      }
      if (method === "GET" && path === "/readyz") return json(response, 200, { status: "ready" });
      if (method === "GET" && path === "/api/config") return json(response, 200, { demo, chainId: config.chainId });
      if (method === "POST" && path === "/api/demo/session" && demo) {
        const input = await body(request);
        fields(input, ["role"]);
        expect(typeof input.role === "string" && Object.hasOwn(demoKeys, input.role), 400, "Choose a demo role.");
        return json(response, 200, { token: keys[input.role] });
      }

      expect(path.startsWith("/api/"), 404, "Page not found.");
      const actor = actorFor(request.headers.authorization, keys);
      expect(actor, 401, "Sign in with a workspace token.");
      if (method === "GET" && path === "/api/me") return json(response, 200, { actor, ...publicConfig });
      if (method === "GET" && path === "/api/safe") return json(response, 200, await chain.snapshot());
      if (method === "GET" && path === "/api/proposals") {
        return json(response, 200, { proposals: store.list().map(p => ({
          id: p.id, revision: p.revision, title: p.current.title, status: status(p, config),
          transfer: p.current.review.transfer, updatedAt: p.updatedAt,
        })) });
      }
      if (method === "POST" && path === "/api/proposals") {
        expect(actor === "proposer", 403, "Only a proposer can create a proposal.");
        return json(response, 201, view(store.create(candidate(await body(request), config), actor)));
      }

      const match = /^\/api\/proposals\/([\da-f-]{36})(?:\/(approve|export|execution))?$/.exec(path);
      expect(match, 404, "Route not found.");
      const [, id, action] = match;
      if (method === "GET" && !action) return json(response, 200, view(store.details(id)));
      if (method === "PUT" && !action) {
        expect(actor === "proposer", 403, "Only a proposer can revise a proposal.");
        const input = await body(request);
        fields(input, ["current", "title"], ["tx", "transfer"]);
        const { current, ...proposal } = input;
        return json(response, 200, view(store.revise(id, revisionRef(current), candidate(proposal, config), actor)));
      }
      if (method === "POST" && action === "approve") {
        expect(actor === "reviewer", 403, "Only a reviewer can approve a proposal.");
        const ref = revisionRef(await body(request));
        const proposal = store.details(id);
        store.checkRef(proposal, ref);
        expect(proposal.current.review.allowed, 422, "Policy checks did not pass.");
        expect(proposal.current.policyHash === config.policyHash, 409, "Policy has changed. Save a fresh revision.");
        const snapshot = await chain.snapshot(proposal.current.tx);
        return json(response, 200, view(store.approve(id, ref, config.policyHash, snapshot, actor)));
      }
      if (method === "POST" && action === "export") {
        const ref = revisionRef(await body(request));
        const proposal = store.details(id);
        store.checkRef(proposal, ref);
        store.checkApproval(proposal, config.policyHash);
        expect(!proposal.execution, 409, "An executed proposal cannot be exported for signing.");
        const snapshot = await chain.snapshot(proposal.current.tx);
        const latest = store.details(id);
        store.checkRef(latest, ref);
        store.checkApproval(latest, config.policyHash);
        expect(!latest.execution, 409, "An executed proposal cannot be exported for signing.");
        return json(response, 200, {
          schema: 1, proposalId: id, revision: ref.revision, tx: proposal.current.tx,
          safeTxHash: ref.safeTxHash, policyHash: config.policyHash, approval: latest.approval, safe: snapshot,
        }, { "Content-Disposition": `attachment; filename="treasury-${id}-r${ref.revision}.json"` });
      }
      if (method === "POST" && action === "execution") {
        expect(actor === "reviewer", 403, "Only a reviewer can record execution.");
        const input = await body(request);
        const ref = revisionRef(input, ["transactionHash"]);
        const txHash = hash(input.transactionHash, "execution transaction hash");
        const proposal = store.details(id);
        store.checkRef(proposal, ref);
        store.checkApproval(proposal, config.policyHash);
        if (proposal.execution?.transactionHash === txHash) return json(response, 200, view(proposal));
        expect(!proposal.execution, 409, "An execution is already recorded for this proposal.");
        const proof = await chain.execution(txHash, proposal.current, proposal.approval);
        return json(response, 200, view(store.executed(id, ref, config.policyHash, proof, actor)));
      }
      throw new DeskError(404, "Route not found.");
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (error instanceof DeskError) {
        return json(response, error.status, { error: error.message },
          error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
      }
      console.error("Treasury request failed:", error.name, error.code ?? "");
      return json(response, 500, { error: "Treasury storage or request processing failed." });
    }
  });
  return server;
}

export async function listen(server, port = 8897, host = "127.0.0.1") {
  server.listen(port, host);
  await once(server, "listening");
  return `http://${host}:${server.address().port}`;
}

export async function stop(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
