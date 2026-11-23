import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";
import { chainReader, receiptMatches } from "../src/chain.mjs";
import { configuration, evaluate, safeAbi, safeArgs, safeHash, tokenAbi, transferTx } from "../src/treasury.mjs";

const token = "0x0000000000000000000000000000000000000010";
const recipient = "0x0000000000000000000000000000000000000020";
const safe = "0x0000000000000000000000000000000000000040";
const config = configuration({ chainId: 31337, safe, rpcUrl: "http://127.0.0.1:8545", confirmations: 2,
  tokens: [{ address: token, symbol: "USDX", decimals: 6, limit: "1000", recipients: [recipient] }] });
const tx = transferTx(config, token, recipient, "100", "3");
const review = evaluate(tx, config);
const bundle = { tx, review, safeTxHash: safeHash(tx) };
const receiptHash = "0x" + "20".repeat(32);
const blockHash = "0x" + "30".repeat(32);
const encode = value => encodeAbiParameters([{ type: "uint256" }], [value]);
const input = value => encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
  args: [...safeArgs(value).slice(0, -1), "0x"] });
const chainTx = { hash: receiptHash, blockHash, to: safe, input: input(tx) };
const safeLog = { address: safe, logIndex: 1,
  topics: encodeEventTopics({ abi: safeAbi, eventName: "ExecutionSuccess", args: { txHash: bundle.safeTxHash } }), data: encode(0n) };
const transferLog = { address: token, logIndex: 0,
  topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: safe, to: recipient } }), data: encode(100n) };
const receipt = { transactionHash: receiptHash, blockHash, status: "success", to: safe, blockNumber: 20n,
  logs: [transferLog, safeLog] };

test("receipt binds direct execution, verified Safe event, and exact token event", () => {
  const check = (otherTx, otherReceipt) => receiptMatches(bundle, tx, review, config, otherTx, otherReceipt);
  assert.equal(check(chainTx, receipt).safeLogIndex, 1);
  assert.throws(() => check(chainTx, { ...receipt, status: "reverted" }), { status: 422 });
  assert.throws(() => check({ ...chainTx, to: token }, receipt), { status: 422 });
  assert.throws(() => check({ ...chainTx, input: input({ ...tx, safeTxGas: "100" }) }, receipt), { status: 422 });
  assert.throws(() => check(chainTx, { ...receipt, logs: [transferLog, { ...safeLog, address: recipient }] }), { status: 422 });
  assert.throws(() => check(chainTx, { ...receipt, logs: [{ ...transferLog, data: encode(101n) }, safeLog] }), { status: 422 });
  assert.throws(() => check(chainTx, { ...receipt, logs: [transferLog, { ...safeLog, removed: true }] }), { status: 422 });
});

test("chain reader rejects an unconfirmed, reorganized, or preapproval receipt", async () => {
  const stub = {
    getChainId: async () => 31337, getTransaction: async () => chainTx, getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => 21n, getBlock: async () => ({ hash: blockHash }),
  };
  const approval = { blockNumber: "19" };
  assert.equal((await chainReader(config, stub).execution(receiptHash, bundle, approval)).confirmations, "2");
  await assert.rejects(chainReader(config, { ...stub, getBlockNumber: async () => 20n })
    .execution(receiptHash, bundle, approval), { status: 409 });
  await assert.rejects(chainReader(config, { ...stub, getBlock: async () => ({ hash: "0x" }) })
    .execution(receiptHash, bundle, approval), { status: 409 });
  await assert.rejects(chainReader(config, stub).execution(receiptHash, bundle, { blockNumber: "21" }), { status: 422 });
});

test("approval snapshot requires the configured chain, exact current nonce, and real Safe hash", async () => {
  const values = { VERSION: "1.4.1", nonce: 3n, getThreshold: 1n, getOwners: [recipient], getTransactionHash: bundle.safeTxHash };
  const stub = {
    getChainId: async () => 31337, getBlockNumber: async () => 20n,
    readContract: async ({ functionName, blockNumber }) => {
      assert.equal(blockNumber, 20n);
      return values[functionName];
    },
  };
  const reader = chainReader(config, stub);
  assert.equal((await reader.snapshot(tx)).nonce, "3");
  await assert.rejects(chainReader(config, { ...stub, getChainId: async () => 1 }).snapshot(tx), { status: 503 });
  values.nonce = 4n;
  await assert.rejects(reader.snapshot(tx), { status: 409 });
  values.getTransactionHash = receiptHash;
  await assert.rejects(reader.snapshot(tx), { status: 422 });
  values.VERSION = "1.3.0";
  await assert.rejects(reader.snapshot(tx), { status: 503 });
});
