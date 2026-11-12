import { mkdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import { ClaudeBlueprintSessions } from "../../adapters/claude/claude-blueprint-sessions.js";
import { ClaudeBuildAgents } from "../../adapters/claude/claude-build-agents.js";
import { ClaudeCli } from "../../adapters/claude/claude-cli.js";
import { ClaudeUserConnectors } from "../../adapters/claude/claude-connectors.js";
import { openClaudeSession } from "../../adapters/claude/claude-session.js";
import { parseTranscriptTurns } from "../../adapters/claude/transcript-turns.js";
import { TranscriptUsage } from "../../adapters/claude/transcript-usage.js";
import { GhTokenSource } from "../../adapters/gh/gh-token-source.js";
import { GitFolderState } from "../../adapters/git/git-state.js";
import { GitWorktree } from "../../adapters/git/worktree.js";
import { HookSocketServer } from "../../adapters/hook-socket/hook-socket-server.js";
import { prepareKit } from "../../adapters/node-fs/kit-copy.js";
import { NodeFileSystem } from "../../adapters/node-fs/node-file-system.js";
import { HomeLock } from "../../adapters/process/home-lock.js";
import { SqliteFlowStore } from "../../adapters/sqlite/flows.js";
import { openDatabase } from "../../adapters/sqlite/open-database.js";
import { SqliteStore } from "../../adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../adapters/tmux/tmux-session-host.js";
import { createAppWaiter } from "./app-waiter.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
  type EngineStores,
} from "./engine-handler.js";
import { prepareHooks } from "./hooks.js";
import { prepareMcpScript } from "./mcp-script.js";
import type { EngineMessage, EngineRequest } from "./protocol.js";

const home = process.env["FLOWDECK_HOME"];
if (home === undefined) throw new Error("engine needs FLOWDECK_HOME");
mkdirSync(home, { recursive: true });

const dbPath = join(home, "flowdeck.db");

const claudeConfig = process.env["FLOWDECK_CLAUDE_CONFIG"] || undefined;

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

const waits = createAppWaiter({ push: post });

const usage = new TranscriptUsage({
  findTranscript: (id) => new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(id),
});

const run: EngineHandlerOptions["run"] = {
  fs,
  now: Date.now,
  startEvents: async (socketPath) => {
    await mkdir(dirname(socketPath), { recursive: true });
    const server = new HookSocketServer({ socketPath });
    await server.start();
    return { events: server, permissions: server, stop: () => server.stop() };
  },
  usage,
  compactions: usage,
  openSession: async (options) => {
    const sessions = new TmuxSessionHost({ socketName: options.sessionName });
    return openClaudeSession(options, {
      sessions,
      claude: new ClaudeCli({ sessions }),
      sessionId: options.claudeSessionId,
    });
  },
};

const kit = prepareKit({ sourceDir: join(__dirname, "kit"), home });
kit.catch((error: unknown) => {
  console.log(`engine: kit error ${error instanceof Error ? error.message : String(error)}`);
});

const buildAgents = new ClaudeBuildAgents({
  home,
  sessions: (socketName) => new TmuxSessionHost({ socketName }),
  cli: (sessions) => new ClaudeCli({ sessions }),
  events: async (socketPath) => {
    await mkdir(dirname(socketPath), { recursive: true });
    const server = new HookSocketServer({ socketPath });
    await server.start();
    return { events: server, stop: () => server.stop() };
  },
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const prepareBlueprint = async (): Promise<EngineHandlerOptions["blueprint"]> => {
  try {
    const blueprintKit = await prepareKit({
      sourceDir: join(__dirname, "kit-blueprint"),
      home,
      root: "blueprint-kit",
    });
    return {
      sessions: new ClaudeBlueprintSessions({
        sessions: (socketName) => new TmuxSessionHost({ socketName }),
        cli: (sessions) => new ClaudeCli({ sessions }),
      }),
      kitDir: blueprintKit.dir,
      mcpScript: prepareMcpScript({ bundleDir: __dirname, home, path: process.env["PATH"] }),
      githubToken: new GhTokenSource(),
    };
  } catch (error) {
    console.log(`engine: blueprint error ${errorText(error)}`);
    return undefined;
  }
};

const homeLock = new HomeLock(join(home, "engine.lock"));
process.on("exit", () => homeLock.release());
let locked: Promise<boolean> | undefined;
const lockHome = () => (locked ??= homeLock.acquire());

const createHandler = async () =>
  createEngineHandler({
    version: pkg.version,
    openStores,
    home,
    userHome: homedir(),
    publish: post,
    prepareHooks: () =>
      prepareHooks({
        home,
        sourcePath: join(__dirname, "flowdeck-hook.cjs"),
        guardSourcePath: join(__dirname, "flowdeck-build-guard.cjs"),
        webGuardSourcePath: join(__dirname, "flowdeck-web-guard.cjs"),
        pathEnv: process.env["PATH"],
      }),
    buildAgents,
    kit: () => kit,
    isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
    fs,
    connectors: new ClaudeUserConnectors(
      claudeConfig === undefined ? {} : { configPath: claudeConfig },
    ),
    run,
    waits,
    worktree: new GitWorktree(),
    gitState: new GitFolderState(),
    sessionAlive: (name) => new TmuxSessionHost({ socketName: name }).has(name),
    endSession: (name) => new TmuxSessionHost({ socketName: name }).stop(name),
    homeLock: { acquire: lockHome },
    blueprint: await prepareBlueprint(),
    transcriptTurns: async (claudeSessionId) => {
      const transcript = await new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(
        claudeSessionId,
      );
      return transcript === undefined
        ? []
        : parseTranscriptTurns(await readFile(transcript, "utf8"));
    },
  });

const handler = createHandler();

process.parentPort.on("message", (event: { data: EngineRequest }) => {
  void handler.then((ready) => ready.handle(event.data)).then(post);
});

void handler
  .then((ready) => ready.startUp())
  .catch((error: unknown) => {
    console.log(`engine: reattach error ${errorText(error)}`);
  });

process.on("SIGTERM", () => {
  void handler
    .then((ready) => ready.detach())
    .catch((error: unknown) => {
      console.log(`engine: detach error ${errorText(error)}`);
    })
    .finally(() => process.exit(0));
});
