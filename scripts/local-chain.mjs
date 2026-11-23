import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  concatHex, createWalletClient, decodeEventLog, encodeFunctionData, http, zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { publicClient } from "../src/chain.mjs";
import { configuration, LOCAL_CHAIN, safeAbi, safeArgs, safeHash, tokenAbi } from "../src/treasury.mjs";

const require = createRequire(import.meta.url);
const safeArtifact = require("@safe-global/safe-contracts/build/artifacts/contracts/Safe.sol/Safe.json");
const proxyFactory = require("@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json");
const fixtureMnemonic = "test test test test test test test test test test test junk";

async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

function tokenArtifact() {
  const source = readFileSync(new URL("../fixtures/FixtureToken.sol", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const artifact = require("../fixtures/fixture-token.json");
  if (createHash("sha256").update(source).digest("hex") !== artifact.sourceSha256) {
    throw new Error("The fixture token source changed. Rebuild its bytecode before verifying the demo.");
  }
  return artifact;
}

export async function localChain({ confirmations = 1 } = {}) {
  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.env.ANVIL_PATH || "anvil", [
    "--host", "127.0.0.1", "--port", String(port), "--chain-id", String(LOCAL_CHAIN),
    "--mnemonic", fixtureMnemonic, "--silent",
  ], { stdio: "ignore", windowsHide: true });
  let startupError;
  child.on("error", error => { startupError = error; });
  const closed = new Promise(resolve => child.once("close", resolve));
  async function close() {
    if (child.exitCode === null && child.signalCode === null && child.pid) child.kill();
    await closed;
  }

  try {
    const client = publicClient({ rpcUrl });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (startupError) throw new Error("Install Foundry Anvil or set ANVIL_PATH.");
      if (child.exitCode !== null) throw new Error("The isolated Anvil process exited.");
      if (await client.getChainId().catch(() => null) === LOCAL_CHAIN) {
        ready = true;
        break;
      }
      await delay(150);
    }
    if (!ready) throw new Error("Anvil did not become ready.");
    const accounts = Array.from({ length: 5 }, (_, addressIndex) => mnemonicToAccount(fixtureMnemonic, { addressIndex }));
    const owners = accounts.slice(0, 2).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
    const recipients = accounts.slice(2, 4).map(account => account.address);
    const blocked = accounts[4].address;
    const wallet = createWalletClient({ account: accounts[0], chain: foundry, transport: http(rpcUrl, { retryCount: 0 }) });
    async function wait(hash) {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 15_000, pollingInterval: 30 });
      if (receipt.status !== "success") throw new Error(`Fixture transaction reverted: ${hash}`);
      return receipt;
    }
    async function deploy(artifact, args = []) {
      const receipt = await wait(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
      if (!receipt.contractAddress) throw new Error("Deployment receipt has no contract address.");
      return receipt.contractAddress;
    }
    const singleton = await deploy(safeArtifact);
    const factory = await deploy(proxyFactory);
    const setup = encodeFunctionData({ abi: safeArtifact.abi, functionName: "setup",
      args: [owners.map(owner => owner.address), 2n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
    const proxyReceipt = await wait(await wallet.writeContract({
      address: factory, abi: proxyFactory.abi, functionName: "createProxyWithNonce", args: [singleton, setup, 1n],
    }));
    const event = proxyReceipt.logs.map(log => {
      try { return decodeEventLog({ abi: proxyFactory.abi, ...log }); } catch { return null; }
    }).find(decoded => decoded?.eventName === "ProxyCreation");
    if (!event) throw new Error("No Safe proxy creation event.");
    const safe = event.args.proxy;
    const token = await deploy(tokenArtifact(), [safe]);
    const config = configuration({
      chainId: LOCAL_CHAIN, rpcUrl, safe, confirmations,
      tokens: [{ address: token, symbol: "USDX", decimals: 6, limit: "250000000", recipients }],
    });

    async function simulate(tx, count = owners.length) {
      if (tx.chainId !== LOCAL_CHAIN || tx.safe !== config.safe) throw new Error("Fixture signer is limited to its own local Safe.");
      const signatures = concatHex(await Promise.all(owners.slice(0, count).map(owner => owner.sign({ hash: safeHash(tx) }))));
      return client.simulateContract({
        account: wallet.account, address: safe, abi: safeAbi, functionName: "execTransaction",
        args: [...safeArgs(tx).slice(0, -1), signatures],
      });
    }
    async function execute(tx) {
      const { request, result } = await simulate(tx);
      if (!result) throw new Error("Safe simulation returned false.");
      return wait(await wallet.writeContract(request));
    }
    async function balance(account) {
      return client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [account] });
    }
    const mine = () => client.request({ method: "evm_mine" });
    return { config, client, close, recipients, blocked, token, proxyReceipt, simulate, execute, balance, mine };
  } catch (error) {
    await close();
    throw error;
  }
}
