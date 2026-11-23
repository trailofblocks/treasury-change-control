import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { transferTx } from "../src/treasury.mjs";
import { localChain } from "./local-chain.mjs";

const ledger = await localChain({ confirmations: 2 });
const dir = await mkdtemp(join(tmpdir(), "treasury-proof-"));
let worker;
let closed;
async function stopProcess() {
  if (!worker) return;
  if (worker.exitCode === null && worker.signalCode === null && worker.pid) worker.kill("SIGKILL");
  await closed;
  worker = null;
}
try {
  const checks = {};
  const { safe, chainId, rpcUrl, tokens, confirmations } = ledger.config;
  const configFile = join(dir, "policy.json");
  await writeFile(configFile, JSON.stringify({ safe, chainId, rpcUrl, tokens, confirmations }));
  const keys = { proposer: randomBytes(24).toString("hex"), reviewer: randomBytes(24).toString("hex") };
  let url;
  async function open() {
    worker = spawn(process.execPath, ["src/main.mjs"], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TREASURY_CONFIG: configFile, TREASURY_DB: join(dir, "desk.sqlite"),
        TREASURY_PROPOSER_TOKEN: keys.proposer, TREASURY_REVIEWER_TOKEN: keys.reviewer,
        TREASURY_PORT: "0", TREASURY_HOST: "127.0.0.1" },
    });
    let errorOutput = "";
    worker.on("error", error => { errorOutput += error.code ?? error.name; });
    worker.stderr.on("data", chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-1500); });
    closed = new Promise(resolve => worker.once("close", resolve));
    const lines = createInterface({ input: worker.stdout });
    const online = new Promise(resolve => {
      lines.on("line", line => {
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
        if (match) resolve(match[0]);
      });
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Desk startup timed out.")), 10_000).unref());
    url = await Promise.race([online, timeout, closed.then(code => { throw new Error(`Desk exited (${code}): ${errorOutput}`); })]);
    lines.close();
  }
  await open();
  async function call(path, { actor = "proposer", method = "GET", body, status = 200 } = {}) {
    const response = await fetch(url + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(actor ? { Authorization: `Bearer ${keys[actor]}` } : {}) },
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  const ref = p => ({ revision: p.revision, safeTxHash: p.current.safeTxHash });
  const route = p => `/api/proposals/${p.id}`;
  const post = (path, body, status = 200, actor = "reviewer") => call(path, { method: "POST", body, status, actor });
  const approve = (p, status = 200, role = "reviewer") => post(route(p) + "/approve", ref(p), status, role);
  const packet = (p, status = 200) => post(route(p) + "/export", ref(p), status, "proposer");
  const draft = (title, recipient, amount) => ({ title, tx: transferTx(ledger.config, ledger.token, recipient, amount, "0") });
  const revise = (p, title, to, amount) => call(route(p), { method: "PUT",
    body: { current: ref(p), ...draft(title, to, amount) } });
  const execution = (p, hash, status = 200) => post(route(p) + "/execution", { ...ref(p), transactionHash: hash }, status);

  await call("/api/proposals", { actor: null, status: 401 });
  checks.unauthenticated_read_blocked = true;
  assert.equal((await call("/api/config", { actor: null })).demo, false);
  await post("/api/demo/session", { role: "reviewer" }, 404);
  checks.production_entry_point_has_no_demo_session = true;
  const unsafe = await post("/api/proposals", draft("Over limit", ledger.recipients[0], "250000001"), 201, "proposer");
  assert.equal(unsafe.status, "blocked");
  await approve(unsafe, 422);
  checks.amount_limit_enforced = true;
  const initial = await post("/api/proposals", draft("Vendor payout", ledger.recipients[0], "125000000"), 201, "proposer");
  await approve(initial, 403, "proposer");
  await packet(initial, 409);
  checks.separate_reviewer_required = true;
  const approved = await approve(initial);
  assert.equal((await packet(approved)).safeTxHash, initial.current.safeTxHash);
  checks.hash_verified_against_safe_contract = true;

  const tampered = await revise(initial, "Vendor payout", ledger.blocked, "125000000");
  assert.equal(tampered.status, "blocked");
  assert.equal(tampered.approval, null);
  assert.equal(tampered.audit[0].supersededApproval, true);
  await approve(initial, 409);
  await packet(initial, 409);
  await approve(tampered, 422);
  checks.changed_recipient_invalidates_approval = true;
  const corrected = await revise(tampered, "Vendor payout", ledger.recipients[1], "125000000");
  await packet(corrected, 409);
  const signedOff = await approve(corrected);
  const exportBundle = await packet(signedOff);
  assert.equal(exportBundle.revision, 3);
  assert.notEqual(exportBundle.safeTxHash, initial.current.safeTxHash);
  checks.corrected_transfer_requires_fresh_approval = true;

  const sibling = await post("/api/proposals", draft("Competing nonce", ledger.recipients[0], "130000000"), 201, "proposer");
  await approve(sibling);
  await assert.rejects(ledger.simulate(exportBundle.tx, 1));
  checks.safe_requires_two_owner_signatures = true;
  await execution(signedOff, ledger.proxyReceipt.transactionHash, 422);
  checks.unrelated_receipt_rejected = true;
  const balanceBefore = await ledger.balance(ledger.recipients[1]);
  const receipt = await ledger.execute(exportBundle.tx);
  assert.equal(await ledger.balance(ledger.recipients[1]) - balanceBefore, 125000000n);
  checks.exact_token_balance_delta = true;
  await execution(signedOff, receipt.transactionHash, 409);
  checks.confirmations_enforced = true;
  await ledger.mine();
  const done = await execution(signedOff, receipt.transactionHash);
  assert.equal(done.status, "executed");
  assert.equal(done.execution.safeTxHash, exportBundle.safeTxHash);
  assert.equal((await execution(signedOff, receipt.transactionHash)).audit.filter(row => row.action === "executed").length, 1);
  checks.receipt_verified_and_linked_once = true;
  await packet(sibling, 409);
  checks.consumed_nonce_blocks_previously_approved_export = true;

  await stopProcess();
  await open();
  const recovered = await call(route(signedOff));
  assert.equal(recovered.status, "executed");
  assert.equal(recovered.execution.transactionHash, receipt.transactionHash);
  assert.equal(recovered.history.length, 3);
  checks.revisions_and_audit_survive_restart = true;
  const report = {
    checks, chainId: ledger.config.chainId, safe: ledger.config.safe, token: ledger.token, threshold: 2,
    supersededHash: initial.current.safeTxHash, approval: recovered.approval, execution: recovered.execution,
    recipient: ledger.recipients[1], transferBaseUnits: "125000000", audit: recovered.audit,
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/local-proof.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ checks, safe: report.safe, execution: report.execution.transactionHash }, null, 2));
} finally {
  await stopProcess();
  await ledger.close();
  for (const file of ["desk.sqlite", "desk.sqlite-wal", "desk.sqlite-shm", "policy.json"]) await rm(join(dir, file), { force: true });
  await rmdir(dir);
}
