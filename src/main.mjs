import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDesk, listen, stop } from "./api.mjs";
import { openStore } from "./store.mjs";
import { expect, runtimeConfig } from "./treasury.mjs";

let store;
let server;
try {
  const { config, keys } = runtimeConfig();
  const path = process.env.TREASURY_DB || ".local/treasury.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  store = openStore(path);
  server = createDesk({ store, config, keys });
  const port = Number(process.env.TREASURY_PORT || "8897");
  expect(Number.isInteger(port) && port >= 0 && port <= 65535, 400, "Choose a valid port.");
  const url = await listen(server, port, process.env.TREASURY_HOST || "127.0.0.1");
  console.log(`Treasury Change Control is listening at ${url}`);
  const shutdown = () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    stop(server).finally(() => store.close()).catch(() => { process.exitCode = 1; });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  if (server?.listening) await stop(server);
  store?.close();
  console.error(`Treasury Change Control: ${error.status ? error.message : error.code ?? error.name}`);
  process.exitCode = 1;
}
