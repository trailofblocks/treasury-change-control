import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { publicClient } from "../src/chain.mjs";
import { configuration, safeAbi, safeArgs, safeHash, SAFE_VERSION, SEPOLIA, transferTx } from "../src/treasury.mjs";

// The published Safe v1.4.1 singleton is sufficient for an independent read-only hash check.
const singleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const token = "0x0000000000000000000000000000000000000001";
const recipient = "0x0000000000000000000000000000000000000002";
const rpcs = process.env.TREASURY_SEPOLIA_RPC_URL
  ? [process.env.TREASURY_SEPOLIA_RPC_URL]
  : ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"];

let proof;
for (const rpcUrl of rpcs) {
  try {
    const config = configuration({ chainId: SEPOLIA, safe: singleton, rpcUrl,
      tokens: [{ address: token, symbol: "EXAMPLE", decimals: 6, limit: "1000000", recipients: [recipient] }] });
    const client = publicClient(config);
    assert.equal(await client.getChainId(), SEPOLIA);
    const block = await client.getBlock({ blockTag: "latest" });
    const tx = transferTx(config, token, recipient, "1000000", "0");
    const call = (functionName, args) => client.readContract({
      address: singleton, abi: safeAbi, functionName, args, blockNumber: block.number,
    });
    const [version, contractHash] = await Promise.all([call("VERSION"), call("getTransactionHash", safeArgs(tx))]);
    assert.equal(version, SAFE_VERSION);
    assert.equal(contractHash, safeHash(tx));
    proof = { chainId: SEPOLIA, mode: "read-only singleton hash comparison", singleton, version,
      blockNumber: block.number.toString(), blockHash: block.hash, transaction: tx, safeTxHash: contractHash };
    break;
  } catch {
    console.error("Sepolia read failed at an RPC endpoint. Trying the next configured endpoint.");
  }
}
if (!proof) {
  console.error("No Sepolia endpoint returned the expected Safe result.");
  process.exitCode = 1;
} else {
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/sepolia-hash-check.json", JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof, null, 2));
}
