import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData, encodeFunctionData, formatUnits, getAddress, hashTypedData,
  isAddress, keccak256, parseAbi, stringToHex, zeroAddress,
} from "viem";

export const LOCAL_CHAIN = 31337;
export const SEPOLIA = 11155111;
export const SAFE_VERSION = "1.4.1";

export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
]);
export const tokenAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

const details = [
  { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
  { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
];
const numbers = ["value", "safeTxGas", "baseGas", "gasPrice", "nonce"];
const UINT_MAX = (1n << 256n) - 1n;
const TOKEN = /^[A-Za-z0-9._~-]{24,256}$/;
export const demoKeys = {
  proposer: "treasury-demo-proposer-fixture",
  reviewer: "treasury-demo-reviewer-fixture",
};

export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function expect(condition, status, message) {
  if (!condition) throw new DeskError(status, message);
}

export function fields(object, required, optional = []) {
  expect(object && typeof object === "object" && !Array.isArray(object), 400, "Expected a JSON object.");
  const keys = Object.keys(object);
  expect(required.every(key => Object.hasOwn(object, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key)), 400, "Unexpected or missing fields.");
}

export function address(value, name) {
  expect(typeof value === "string" && isAddress(value), 400, `Invalid ${name} address.`);
  return getAddress(value);
}

export function uint(value, name) {
  expect(typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value), 400,
    `${name} must be a decimal string in base units.`);
  expect(BigInt(value) <= UINT_MAX, 400, `${name} exceeds uint256.`);
  return value;
}

export function hash(value, name) {
  expect(typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value), 400, `Invalid ${name}.`);
  return value.toLowerCase();
}

export function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function text(value, name, limit) {
  expect(typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit, 400,
    `Enter a ${name} of up to ${limit} characters.`);
  return value.trim();
}

export function configuration(raw) {
  fields(raw, ["chainId", "safe", "rpcUrl", "tokens"], ["confirmations"]);
  expect([LOCAL_CHAIN, SEPOLIA].includes(raw.chainId), 400, "Choose Sepolia or the local test chain.");
  let url;
  try { url = new URL(raw.rpcUrl); } catch { throw new DeskError(400, "Invalid RPC URL."); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  expect(url.protocol === "https:" || (local && raw.chainId === LOCAL_CHAIN && url.protocol === "http:"),
    400, "Use HTTPS for remote RPC connections.");
  const safe = address(raw.safe, "Safe");
  expect(safe !== zeroAddress, 400, "Configure a deployed Safe address.");
  const confirmations = raw.confirmations ?? (raw.chainId === SEPOLIA ? 3 : 1);
  expect(Number.isInteger(confirmations) && confirmations >= 1 && confirmations <= 30, 400,
    "Confirmations must be between 1 and 30.");
  expect(Array.isArray(raw.tokens) && raw.tokens.length >= 1 && raw.tokens.length <= 20, 400,
    "Configure between 1 and 20 approved tokens.");
  const tokens = raw.tokens.map(entry => {
    fields(entry, ["address", "symbol", "decimals", "limit", "recipients"]);
    expect(Number.isInteger(entry.decimals) && entry.decimals >= 0 && entry.decimals <= 36, 400,
      "Token decimals must be between 0 and 36.");
    const token = address(entry.address, "token");
    expect(token !== zeroAddress && token !== safe, 400, "Configure a separate token address.");
    const limit = uint(entry.limit, "limit");
    expect(limit !== "0", 400, "The transfer limit must be positive.");
    expect(Array.isArray(entry.recipients) && entry.recipients.length > 0 && entry.recipients.length <= 100, 400,
      "Configure between 1 and 100 recipients per token.");
    const recipients = Array.from(new Set(entry.recipients.map(value => address(value, "recipient")))).sort();
    expect(!recipients.includes(zeroAddress), 400, "The zero address cannot receive treasury transfers.");
    return { address: token, symbol: text(entry.symbol, "symbol", 12), decimals: entry.decimals, limit, recipients };
  }).sort((a, b) => a.address.localeCompare(b.address));
  expect(new Set(tokens.map(t => t.address)).size === tokens.length, 400, "Token addresses must be unique.");
  const policy = { schema: 1, chainId: raw.chainId, safe, confirmations, tokens };
  return { ...policy, rpcUrl: url.toString(), policyHash: keccak256(stringToHex(JSON.stringify(policy))) };
}

export function runtimeConfig(env = process.env) {
  expect(env.TREASURY_CONFIG, 400, "Set TREASURY_CONFIG to the policy JSON path.");
  const config = configuration(JSON.parse(readFileSync(env.TREASURY_CONFIG, "utf8")));
  const keys = { proposer: env.TREASURY_PROPOSER_TOKEN, reviewer: env.TREASURY_REVIEWER_TOKEN };
  expect(Object.values(keys).every(key => TOKEN.test(key ?? "") && !Object.values(demoKeys).includes(key)) &&
    keys.proposer !== keys.reviewer, 400, "Configure two distinct role tokens of 24–256 URL-safe characters.");
  return { config, keys };
}

export function actorFor(header, keys) {
  const match = typeof header === "string" && /^Bearer ([A-Za-z0-9._~-]{24,256})$/i.exec(header);
  if (!match) return null;
  const provided = Buffer.from(match[1]);
  return Object.keys(keys).find(role => {
    const expected = Buffer.from(keys[role]);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }) ?? null;
}

export function normalizeTx(raw, config) {
  fields(raw, ["safe", "chainId", ...details.map(field => field.name)], ["safeTxHash"]);
  expect(raw.chainId === config.chainId && sameAddress(address(raw.safe, "Safe"), config.safe), 422,
    "The proposal targets a different Safe or network.");
  expect(raw.operation === 0 || raw.operation === 1, 400, "Operation must be 0 or 1.");
  expect(typeof raw.data === "string" && /^0x(?:[\da-fA-F]{2}){0,1024}$/.test(raw.data), 400,
    "Calldata must be even-length hexadecimal and at most 1,024 bytes.");
  const tx = {
    safe: config.safe, chainId: config.chainId, to: address(raw.to, "destination"), data: raw.data.toLowerCase(),
    operation: raw.operation, gasToken: address(raw.gasToken, "gas token"),
    refundReceiver: address(raw.refundReceiver, "refund receiver"),
  };
  for (const name of numbers) tx[name] = uint(raw[name], name);
  if (Object.hasOwn(raw, "safeTxHash")) {
    expect(hash(raw.safeTxHash, "claimed Safe transaction hash") === safeHash(tx), 422,
      "The claimed Safe hash differs from the transaction payload.");
  }
  return tx;
}

export function safeArgs(tx) {
  return details.map(({ name }) => numbers.includes(name) ? BigInt(tx[name]) : tx[name]);
}

export function safeHash(tx) {
  const args = safeArgs(tx);
  const message = Object.fromEntries(details.map(({ name }, index) => [name, args[index]]));
  return hashTypedData({
    domain: { chainId: tx.chainId, verifyingContract: tx.safe },
    primaryType: "SafeTx", types: { SafeTx: details }, message,
  });
}

export function transferTx(config, token, recipient, amount, nonce) {
  return normalizeTx({
    safe: config.safe, chainId: config.chainId, to: token, nonce,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer",
      args: [address(recipient, "recipient"), BigInt(uint(amount, "amount"))] }),
    value: "0", operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0",
    gasToken: zeroAddress, refundReceiver: zeroAddress,
  }, config);
}

function transferData(data) {
  if (data.length !== 138 || !data.startsWith("0xa9059cbb")) return null;
  try {
    const decoded = decodeFunctionData({ abi: tokenAbi, data });
    if (encodeFunctionData({ abi: tokenAbi, ...decoded }) !== data) return null;
    return { recipient: getAddress(decoded.args[0]), amount: decoded.args[1].toString() };
  } catch {
    return null;
  }
}

export function evaluate(tx, config) {
  const entry = config.tokens.find(item => sameAddress(item.address, tx.to));
  const transfer = transferData(tx.data);
  const checks = [
    { label: "Direct call", pass: tx.operation === 0 },
    { label: "Zero ETH and gas reimbursement", pass: tx.value === "0" && tx.safeTxGas === "0" &&
      tx.baseGas === "0" && tx.gasPrice === "0" && tx.gasToken === zeroAddress && tx.refundReceiver === zeroAddress },
    { label: "ERC-20 transfer calldata", pass: Boolean(transfer) },
    { label: "Registered token", pass: Boolean(entry) },
    { label: "Recipient on the allowlist", pass: Boolean(transfer && entry?.recipients.includes(transfer.recipient)) },
    { label: "Within the transfer limit", pass: Boolean(transfer && entry &&
      BigInt(transfer.amount) > 0n && BigInt(transfer.amount) <= BigInt(entry.limit)) },
  ];
  return { allowed: checks.every(check => check.pass), checks,
    transfer: transfer && { ...transfer, token: tx.to,
      display: entry ? `${formatUnits(BigInt(transfer.amount), entry.decimals)} ${entry.symbol}` : `${transfer.amount} base units` } };
}

export function prepare(raw, config) {
  fields(raw, ["title", "tx"]);
  const tx = normalizeTx(raw.tx, config);
  return { title: text(raw.title, "proposal title", 100), tx, safeTxHash: safeHash(tx),
    policyHash: config.policyHash, review: evaluate(tx, config) };
}

export function revisionRef(raw, optional = []) {
  fields(raw, ["revision", "safeTxHash", ...optional]);
  expect(Number.isSafeInteger(raw.revision) && raw.revision > 0, 400, "Invalid revision.");
  return { revision: raw.revision, safeTxHash: hash(raw.safeTxHash, "Safe transaction hash") };
}
