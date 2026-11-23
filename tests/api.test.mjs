import assert from "node:assert/strict";
import test from "node:test";
import { createDesk, listen, stop } from "../src/api.mjs";
import { openStore } from "../src/store.mjs";
import { configuration, prepare, safeHash, transferTx } from "../src/treasury.mjs";

const token = "0x0000000000000000000000000000000000000010";
const recipient = "0x0000000000000000000000000000000000000020";
const safe = "0x0000000000000000000000000000000000000040";
const makeConfig = (limit = "1000000") => configuration({ chainId: 31337, safe, rpcUrl: "http://127.0.0.1:8545",
  tokens: [{ address: token, symbol: "USDX", decimals: 6, limit, recipients: [recipient] }] });
const keys = { proposer: "a".repeat(32), reviewer: "b".repeat(32) };
const ready = { nonce: "0", blockNumber: "10" };
const ref = p => ({ revision: p.revision, safeTxHash: p.current.safeTxHash });
const path = p => "/api/proposals/" + p.id;

async function setup(t, options = {}) {
  const store = openStore();
  const config = options.config || makeConfig();
  const chain = options.chain || { snapshot: async () => ready };
  const server = createDesk({ config, store, keys, chain });
  const url = await listen(server, 0);
  t.after(async () => { await stop(server); store.close(); });
  const draft = (title = "Treasury transfer", amount = "500000") => ({ title, tx: transferTx(config, token, recipient, amount, "0") });
  async function request(endpoint, status, { role = "proposer", method = "GET", body } = {}) {
    const response = await fetch(url + endpoint, { method,
      headers: { ...(role ? { Authorization: "Bearer " + keys[role] } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  const post = (endpoint, body, status, role) => request(endpoint, status, { method: "POST", body, role });
  return { store, config, draft, request, post };
}

test("production sessions require tokens and import/export binds the full Safe payload", async t => {
  const { request, post, draft } = await setup(t);
  await request("/api/proposals", 401, { role: null });
  await post("/api/demo/session", { role: "proposer" }, 401, null);
  await post("/api/proposals", draft(), 403, "reviewer");
  const raw = draft();
  const proposal = await post("/api/proposals", { ...raw, tx: { ...raw.tx, safeTxHash: safeHash(raw.tx) } }, 201, "proposer");
  await post("/api/proposals", draft(), 409, "proposer");
  await post(path(proposal) + "/export", ref(proposal), 409, "reviewer");
  await post(path(proposal) + "/approve", ref(proposal), 403, "proposer");
  await post(path(proposal) + "/approve", ref(proposal), 200, "reviewer");
  const replay = await post(path(proposal) + "/approve", ref(proposal), 200, "reviewer");
  assert.equal(replay.audit.filter(event => event.action === "approved").length, 1);
  const exported = await post(path(proposal) + "/export", ref(proposal), 200, "proposer");
  assert.deepEqual(exported.tx, raw.tx);
  assert.equal(exported.approval.safeTxHash, safeHash(exported.tx));
});

test("a slow chain read cannot approve a revision changed before the approval commits", async t => {
  const { promise: started, resolve: began } = Promise.withResolvers();
  const { promise: open, resolve: finish } = Promise.withResolvers();
  const { request, post, draft } = await setup(t, { chain: {
    snapshot: async () => { began(); await open; return ready; },
  } });
  const proposal = await post("/api/proposals", draft(), 201, "proposer");
  const approver = post(path(proposal) + "/approve", ref(proposal), 409, "reviewer");
  await started;
  try {
    const revised = await request(path(proposal), 200, { method: "PUT", body: {
      current: ref(proposal), ...draft("Treasury transfer", "600000"),
    } });
    assert.equal(revised.revision, 2);
    assert.equal(revised.approval, null);
  } finally { finish(); }
  await approver;
});

test("a changed workspace policy requires a fresh revision before export or approval", async t => {
  const { store, config, post, request, draft } = await setup(t, { config: makeConfig("750000") });
  const oldPolicy = makeConfig();
  const proposal = store.create(prepare(draft(), oldPolicy), "proposer");
  store.approve(proposal.id, ref(proposal), oldPolicy.policyHash, ready, "reviewer");
  assert.equal((await request(path(proposal), 200)).status, "stale_policy");
  await post(path(proposal) + "/export", ref(proposal), 409, "reviewer");
  await post(path(proposal) + "/approve", ref(proposal), 409, "reviewer");
  const revised = await request(path(proposal), 200, { method: "PUT", body: { current: ref(proposal), ...draft() } });
  assert.equal(revised.current.policyHash, config.policyHash);
  assert.equal(revised.approval, null);
});
