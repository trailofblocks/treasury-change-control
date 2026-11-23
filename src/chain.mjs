import { createPublicClient, decodeEventLog, decodeFunctionData, http } from "viem";
import {
  DeskError, expect, normalizeTx, safeAbi, safeArgs, safeHash, SAFE_VERSION, sameAddress, tokenAbi,
} from "./treasury.mjs";

export function publicClient(config) {
  return createPublicClient({ transport: http(config.rpcUrl, { timeout: 6_000, retryCount: 0 }), cacheTime: 0 });
}

function matches(log, at, abi, eventName, verify) {
  if (!sameAddress(log.address, at) || log.removed) return false;
  try {
    const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
    return event.eventName === eventName && verify(event.args);
  } catch {
    return false;
  }
}

export function receiptMatches(bundle, tx, review, config, chainTx, receipt) {
  expect(chainTx.hash === receipt.transactionHash && chainTx.blockHash === receipt.blockHash &&
    receipt.status === "success" && sameAddress(chainTx.to, config.safe) && sameAddress(receipt.to, config.safe),
  422, "Expected a successful direct Safe execution.");
  let data;
  try { data = decodeFunctionData({ abi: safeAbi, data: chainTx.input }); } catch {}
  expect(data?.functionName === "execTransaction", 422, "The transaction is not a direct Safe execTransaction call.");
  const [to, value, calldata, operation, gas, base, price, token, refund] = data.args;
  const submitted = normalizeTx({
    ...tx, to, value: value.toString(), data: calldata, operation, safeTxGas: gas.toString(),
    baseGas: base.toString(), gasPrice: price.toString(), gasToken: token, refundReceiver: refund,
  }, config);
  expect(safeHash(submitted) === bundle.safeTxHash, 422, "The executed payload differs from the approved revision.");
  const executed = receipt.logs.filter(log => matches(log, config.safe, safeAbi, "ExecutionSuccess",
    args => args.txHash === bundle.safeTxHash));
  expect(executed.length === 1, 422, "The receipt does not prove execution of the approved Safe hash.");
  const transfer = receipt.logs.filter(log => matches(log, tx.to, tokenAbi, "Transfer",
    args => sameAddress(args.from, config.safe) && sameAddress(args.to, review.transfer.recipient) &&
      args.value.toString() === review.transfer.amount));
  expect(transfer.length === 1, 422, "The receipt does not prove the approved token transfer.");
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash, safeLogIndex: executed[0].logIndex, transferLogIndex: transfer[0].logIndex };
}

export function chainReader(config, client = publicClient(config)) {
  async function rpc(task, message = "The Safe RPC is unavailable. Try again.") {
    try { return await task(); } catch (error) {
      if (error instanceof DeskError) throw error;
      throw new DeskError(503, message);
    }
  }

  async function checkChain() {
    const id = await client.getChainId();
    expect(id === config.chainId, 503, "The RPC is connected to a different chain.");
  }

  async function snapshot(tx) {
    return rpc(async () => {
      await checkChain();
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      const read = (functionName, args) => client.readContract({
        address: config.safe, abi: safeAbi, functionName, args, blockNumber,
      });
      const [version, nonce, threshold, owners, onChainHash] = await Promise.all([
        read("VERSION"), read("nonce"), read("getThreshold"), read("getOwners"),
        tx ? read("getTransactionHash", safeArgs(tx)) : null,
      ]);
      expect(version === SAFE_VERSION && threshold > 0n && threshold <= BigInt(owners.length), 503,
        `Configure an initialized Safe v${SAFE_VERSION}.`);
      if (tx) {
        expect(onChainHash === safeHash(tx), 422, "The Safe contract computed a different hash.");
        expect(nonce.toString() === tx.nonce, 409, "The Safe nonce changed or the proposal is queued for a future nonce.");
      }
      return { version, nonce: nonce.toString(), threshold: Number(threshold), owners, blockNumber: blockNumber.toString() };
    }, "Could not read the configured Safe. Check the RPC and Safe address.");
  }

  async function execution(id, current, approval) {
    return rpc(async () => {
      await checkChain();
      const [chainTx, receipt, latest] = await Promise.all([
        client.getTransaction({ hash: id }), client.getTransactionReceipt({ hash: id }),
        client.getBlockNumber({ cacheTime: 0 }),
      ]);
      expect(receipt.transactionHash === id && receipt.blockNumber >= BigInt(approval.blockNumber), 422,
        "The receipt predates the approval or references a different transaction.");
      const depth = latest - receipt.blockNumber + 1n;
      expect(depth >= BigInt(config.confirmations), 409, "The receipt needs more confirmations.");
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      expect(block.hash === receipt.blockHash, 409, "The receipt is no longer on the canonical chain.");
      const proof = receiptMatches(current, current.tx, current.review, config, chainTx, receipt);
      return { ...proof, confirmations: depth.toString() };
    }, "The transaction or receipt is unavailable from the configured RPC.");
  }

  return { snapshot, execution };
}
