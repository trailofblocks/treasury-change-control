import { createDesk, listen, stop } from "../src/api.mjs";
import { existsSync } from "node:fs";
import { openStore } from "../src/store.mjs";
import { demoKeys } from "../src/treasury.mjs";
import { seedDemo } from "./demo-data.mjs";
import { localChain } from "./local-chain.mjs";

const ledger = await localChain();
const store = openStore();
let server;
try {
  await seedDemo(ledger, store);

  server = createDesk({ store, config: ledger.config, keys: demoKeys, demo: true });
  const port = Number(process.env.TREASURY_PORT || "8897");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Choose a valid TREASURY_PORT.");
  const url = await listen(server, port);
  console.log(`Treasury Change Control demo: ${url}`);
  await new Promise(resolve => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    if (process.env.TREASURY_DEMO_STOP_FILE) {
      const poll = setInterval(() => {
        if (existsSync(process.env.TREASURY_DEMO_STOP_FILE)) {
          clearInterval(poll);
          resolve();
        }
      }, 250);
      poll.unref();
    }
  });
} finally {
  if (server?.listening) await stop(server);
  store.close();
  await ledger.close();
}
