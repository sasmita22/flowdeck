import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { SqliteStore } from "../../adapters/sqlite/sqlite-store.js";
import { createEngineHandler } from "./engine-handler.js";
import type { EngineRequest } from "./protocol.js";

const home = process.env["FLOWDECK_HOME"];
if (home === undefined) throw new Error("engine needs FLOWDECK_HOME");
mkdirSync(home, { recursive: true });

const dbPath = join(home, "flowdeck.db");

const openStore = () => {
  try {
    new SqliteStore({ path: dbPath, migrationsDir: join(__dirname, "migrations") });
    console.log(`engine: store ready ${dbPath}`);
  } catch (error) {
    console.log(`engine: store error ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const handler = createEngineHandler({ version: pkg.version, openStore });

process.parentPort.on("message", (event: { data: EngineRequest }) => {
  process.parentPort.postMessage(handler.handle(event.data));
});
