import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createDesk, listen, stop } from "../src/api.mjs";
import { openStore } from "../src/store.mjs";
import { demoKeys, safeHash, transferTx } from "../src/treasury.mjs";
import { seedDemo } from "./demo-data.mjs";
import { localChain } from "./local-chain.mjs";

const ledger = await localChain();
const store = openStore();
let server;
let browser;
try {
  await seedDemo(ledger, store);
  server = createDesk({ store, config: ledger.config, keys: demoKeys, demo: true });
  const url = await listen(server, 0);
  browser = await chromium.launch({ executablePath: process.env.TREASURY_BROWSER_EXECUTABLE, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.goto(url);
  const button = name => page.getByRole("button", { name, exact: true });
  const editor = page.locator("#proposal-dialog");
  const role = page.getByLabel("Switch demo role");
  async function status(value) {
    await page.waitForFunction(text => document.querySelector("#status").textContent === text &&
      !document.querySelector("#detail").hidden, value);
  }
  async function packet(name) {
    const promise = page.waitForEvent("download");
    await button("Download signing packet").click();
    const file = await promise;
    await file.saveAs(`artifacts/${name}.json`);
    const bundle = JSON.parse(await readFile(`artifacts/${name}.json`, "utf8"));
    assert.equal(safeHash(bundle.tx), bundle.approval.safeTxHash);
    return bundle;
  }
  async function edit(to) {
    await button("Revise proposal").click();
    await editor.getByLabel("Recipient address").fill(to);
    await editor.getByRole("button", { name: "Save proposal" }).click();
    await editor.waitFor({ state: "hidden" });
  }
  await page.getByRole("heading", { name: "November settlement", exact: true }).waitFor();
  await page.getByText("Connected", { exact: true }).waitFor();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desk-desktop.png", fullPage: true });
  await role.selectOption("reviewer");
  await button("Approve revision").click();
  await status("Approved");
  const first = await packet("superseded-packet");
  assert.equal(first.revision, 1);

  await role.selectOption("proposer");
  await edit(ledger.blocked);
  await status("Policy blocked");
  assert.equal(await button("Download signing packet").count(), 0);
  await button("Audit trail").click();
  await page.getByText("Superseded the previous approval.", { exact: true }).waitFor();
  await edit(ledger.recipients[1]);
  await status("In review");
  await role.selectOption("reviewer");
  await button("Approve revision").click();
  await status("Approved");
  const corrected = await packet("approved-packet");
  assert.equal(corrected.revision, 3);
  assert.notEqual(corrected.safeTxHash, first.safeTxHash);
  assert.equal(corrected.tx.nonce, "1");

  const receipt = await ledger.execute(corrected.tx);
  await button("Verify execution").click();
  const receiptForm = page.locator("#receipt-dialog");
  await receiptForm.getByLabel("Execution transaction hash").fill(receipt.transactionHash);
  await receiptForm.getByRole("button", { name: "Verify receipt" }).click();
  await status("Executed");
  await button("Policy checks").click();
  await page.locator("#execution-card").getByText(receipt.transactionHash, { exact: true }).waitFor();
  await page.screenshot({ path: "artifacts/desk-executed.png", fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 860 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await mobile.goto(url);
  await mobile.locator(".queue-item").filter({ hasText: "November settlement" }).click();
  await mobile.locator("#execution-card").getByText(receipt.transactionHash, { exact: true }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: "artifacts/desk-mobile.png", fullPage: true });
  await mobile.close();

  await role.selectOption("proposer");
  await button("New proposal").click();
  await editor.getByLabel("Title").fill("Imported Safe transfer");
  await editor.getByLabel("Input type").selectOption("raw");
  const raw = transferTx(ledger.config, ledger.token, ledger.recipients[0], "12000000", "2");
  await editor.getByLabel("Safe transaction JSON").fill(JSON.stringify({ ...raw, safeTxHash: safeHash(raw) }));
  await editor.getByRole("button", { name: "Save proposal" }).click();
  await page.getByRole("heading", { name: "Imported Safe transfer", exact: true }).waitFor();
  assert.deepEqual(failures, []);
  console.log("Browser workflow passed: role separation, approval, revision invalidation, download, real receipt, mobile layout and JSON import.");
} finally {
  await browser?.close();
  if (server?.listening) await stop(server);
  store.close();
  await ledger.close();
}
