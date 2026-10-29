import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { SqliteFlowStore } from "../../adapters/sqlite/flows.js";
import { openDatabase } from "../../adapters/sqlite/open-database.js";
import { SqliteStore } from "../../adapters/sqlite/sqlite-store.js";
import { createEngineHandler, type EngineStores } from "./engine-handler.js";
import type { EngineRequest } from "./protocol.js";

const home = process.env["FLOWDECK_HOME"];
if (home === undefined) throw new Error("engine needs FLOWDECK_HOME");
mkdirSync(home, { recursive: true });

const dbPath = join(home, "flowdeck.db");

const openStores = (): EngineStores => {
  try {
    const db = openDatabase({ path: dbPath, migrationsDir: join(__dirname, "migrations") });
    const stores = { runs: new SqliteStore({ db }), flows: new SqliteFlowStore({ db }) };
    console.log(`engine: store ready ${dbPath}`);
    return stores;
  } catch (error) {
    console.log(`engine: store error ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const handler = createEngineHandler({ version: pkg.version, openStores });

process.parentPort.on("message", (event: { data: EngineRequest }) => {
  process.parentPort.postMessage(handler.handle(event.data));
});
