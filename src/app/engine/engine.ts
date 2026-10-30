import { mkdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { ClaudeCli } from "../../adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../adapters/claude/claude-session.js";
import { HookSocketServer } from "../../adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../adapters/process/process-runner.js";
import { SqliteFlowStore } from "../../adapters/sqlite/flows.js";
import { openDatabase } from "../../adapters/sqlite/open-database.js";
import { SqliteStore } from "../../adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../adapters/tmux/tmux-session-host.js";
import type { RunEnvironment } from "../../core/run/execute.js";
import { createEngineHandler, type EngineStores } from "./engine-handler.js";
import { prepareHooks } from "./hooks.js";
import type { EngineMessage, EngineRequest } from "./protocol.js";

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

const post = (message: EngineMessage) => process.parentPort.postMessage(message);

const fs = new NodeFileSystem();

const run: RunEnvironment = {
  fs,
  scripts: new NodeProcessRunner(),
  waiter: { wait: () => new Promise(() => undefined) },
  startEvents: async (socketPath) => {
    await mkdir(dirname(socketPath), { recursive: true });
    const server = new HookSocketServer({ socketPath });
    await server.start();
    return { events: server, stop: () => server.stop() };
  },
  openSession: async (options) => {
    const sessions = new TmuxSessionHost({ socketName: options.sessionName });
    return openClaudeSession(options, {
      sessions,
      claude: new ClaudeCli({ sessions }),
      sessionId: options.claudeSessionId,
    });
  },
};

const handler = createEngineHandler({
  version: pkg.version,
  openStores,
  home,
  publish: post,
  prepareHooks: () =>
    prepareHooks({
      home,
      sourcePath: join(__dirname, "flowdeck-hook.cjs"),
      pathEnv: process.env["PATH"],
    }),
  isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
  fs,
  run,
});

process.parentPort.on("message", (event: { data: EngineRequest }) => {
  void handler.handle(event.data).then(post);
});

process.on("SIGTERM", () => {
  void handler
    .stop()
    .catch((error: unknown) => {
      console.log(`engine: stop error ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => process.exit(0));
});
