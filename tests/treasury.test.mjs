import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress } from "viem";
import {
  actorFor, configuration, demoKeys, evaluate, normalizeTx, prepare, safeHash, transferTx,
} from "../src/treasury.mjs";

const token = "0x0000000000000000000000000000000000000010";
const recipient = "0x0000000000000000000000000000000000000020";
const other = "0x0000000000000000000000000000000000000030";
const safe = "0x0000000000000000000000000000000000000040";
const rawConfig = { chainId: 31337, safe, rpcUrl: "http://127.0.0.1:8545",
  tokens: [{ address: token, symbol: "USDX", decimals: 6, limit: "1000000", recipients: [recipient] }] };

const config = configuration(rawConfig);
const sample = transferTx(config, token, recipient, "1000000", "0");

test("the Safe hash covers all transaction fields and the chain and Safe domain", () => {
  const mutations = {
    chainId: 11155111, safe: other, to: other, data: "0x", nonce: "1", value: "1", operation: 1,
    safeTxGas: "1", baseGas: "1", gasPrice: "1", gasToken: token, refundReceiver: recipient,
  };
  assert.equal(new Set([safeHash(sample), ...Object.entries(mutations)
    .map(([key, value]) => safeHash({ ...sample, [key]: value }))]).size, Object.keys(mutations).length + 1);
});

test("import verifies an attached hash and rejects an incorrect Safe or chain", () => {
  assert.deepEqual(normalizeTx({ ...sample, safeTxHash: safeHash(sample) }, config), sample);
  assert.throws(() => normalizeTx({ ...sample, safeTxHash: "0x" + "11".repeat(32) }, config), { status: 422 });
  assert.throws(() => normalizeTx({ ...sample, safe: other }, config), { status: 422 });
  assert.throws(() => normalizeTx({ ...sample, chainId: 11155111 }, config), { status: 422 });
});

test("uint256 inputs are lossless and validation rejects unsafe representations", () => {
  const max = ((1n << 256n) - 1n).toString();
  const prepared = transferTx(config, token, recipient, max, "0");
  assert.equal(evaluate(prepared, config).transfer.amount, max);
  for (const value of ["-1", "1.0", "01", "1e18", 2, (1n << 256n).toString()]) {
    assert.throws(() => transferTx(config, token, recipient, value, "0"), { status: 400 });
  }
});

test("policy blocks unsafe call shapes, unsupported actions, and boundary violations", () => {
  assert.equal(evaluate(sample, config).allowed, true);
  for (const input of [
    { ...sample, operation: 1 }, { ...sample, value: "1" },
    { ...sample, safeTxGas: "1" }, { ...sample, baseGas: "1" },
    { ...sample, gasPrice: "1" }, { ...sample, gasToken: token }, { ...sample, refundReceiver: other },
    { ...sample, to: other }, { ...sample, data: "0x" },
    { ...sample, data: "0x095ea7b3" + sample.data.slice(10) },
    { ...sample, data: sample.data + "00" }, { ...sample, data: sample.data.slice(0, 10) + "11" + sample.data.slice(12) },
    transferTx(config, token, other, "1000000", "0"),
    transferTx(config, token, zeroAddress, "1000000", "0"),
    transferTx(config, token, recipient, "1000001", "0"),
    transferTx(config, token, recipient, "0", "0"),
  ]) assert.equal(evaluate(input, config).allowed, false);
});

test("changing policy details invalidates their fingerprint, list ordering does not", () => {
  const policy = recipients => configuration({ ...rawConfig, tokens: [{ ...rawConfig.tokens[0], recipients }] });
  assert.equal(policy([recipient, other]).policyHash, policy([other, recipient]).policyHash);
  assert.notEqual(policy([recipient, other]).policyHash, config.policyHash);
  assert.throws(() => configuration({ ...rawConfig, chainId: 1 }), { status: 400 });
  assert.throws(() => configuration({ ...rawConfig, rpcUrl: "http://example.test" }), { status: 400 });
});

test("role tokens are exact and proposal input cannot inject fields", () => {
  assert.equal(actorFor(`Bearer ${demoKeys.reviewer}`, demoKeys), "reviewer");
  assert.equal(actorFor(`Bearer ${demoKeys.reviewer}X`, demoKeys), null);
  assert.equal(actorFor("Basic " + demoKeys.proposer, demoKeys), null);
  assert.throws(() => prepare({ title: "Foo", tx: sample, role: "reviewer" }, config), { status: 400 });
});
