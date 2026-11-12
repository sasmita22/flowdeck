import { mkdir, readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { ClaudeBuildAgents } from "../../src/adapters/claude/claude-build-agents.js";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../src/adapters/claude/claude-session.js";
import { parseTranscriptTurns } from "../../src/adapters/claude/transcript-turns.js";
import { GitFolderState } from "../../src/adapters/git/git-state.js";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { createAppWaiter, type AppWaiter } from "../../src/app/engine/app-waiter.js";
import {
  createEngineHandler,
  type EngineHandler,
  type EngineHandlerOptions,
} from "../../src/app/engine/engine-handler.js";
import type { EnginePush, EngineRequest } from "../../src/app/engine/protocol.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { VariableValues } from "../../src/core/flow/variables.js";
import type { RunEnvironment } from "../../src/core/run/execute.js";
import type { PendingBuildEnd, RunStatus } from "../../src/core/run/store.js";
import type { HumanWaiter } from "../../src/core/run/wait.js";
import type { BuildAgents, BuildAgentsOpenSpec } from "../../src/ports/build-agents.js";
import { FakeConnectorSource } from "../fakes/fake-connector-source.js";
import { fakeEngineBuildOptions } from "./fake-build-deps.js";
import { killTmuxServer, removeClaudeSessions } from "./live-claude.js";

export const draftsOnly = process.env.FLOWDECK_LIVE_DRAFTS === "1";

export const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
export const guardScriptPath = fileURLToPath(
  new URL("../../bin/flowdeck-build-guard.ts", import.meta.url),
);

type LiveRun = EngineHandlerOptions["run"];
type OpenSession = RunEnvironment["openSession"];
type StartEvents = RunEnvironment["startEvents"];

export function liveEnvironment(fs: NodeFileSystem): Omit<LiveRun, "waiter"> {
  return {
    fs,
    now: Date.now,
    startEvents: async (socketPath) => {
      await mkdir(dirname(socketPath), { recursive: true });
      const server = new HookSocketServer({ socketPath });
      await server.start();
      return { events: server, permissions: server, stop: () => server.stop() };
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
}

const draftAgents: BuildAgents = {
  open: async () => {},
  turn: async () => ({ kind: "stopped" }),
  alive: async () => true,
  close: async () => {},
};

export function realBuildAgents(home: string): ClaudeBuildAgents {
  return new ClaudeBuildAgents({
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
}

export const liveBuildAgents = (home: string): BuildAgents =>
  draftsOnly ? draftAgents : realBuildAgents(home);

export async function sessionIdsIn(folder: string): Promise<string[]> {
  const slug = folder.replace(/[^a-zA-Z0-9]/g, "-");
  try {
    return (await readdir(join(homedir(), ".claude", "projects", slug)))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.replace(/\.jsonl$/, ""));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export const workFolderOf = (workspaceDir: string, repo: string) =>
  join(workspaceDir, basename(repo));

const keptFiles = (path: string) =>
  path.startsWith("plugin/") || ["manifest.json", "build-report.json", "CLAUDE.md"].includes(path);

async function readWorkspace(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
    if (keptFiles(path)) files.set(path, await readFile(join(dir, path), "utf8"));
  }
  return files;
}

export type LiveStores = {
  runs: SqliteStore;
  flows: SqliteFlowStore;
  ends: Map<string, PendingBuildEnd>;
  close(): void;
};

export function openLiveStores(home: string): LiveStores {
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  const runs = new SqliteStore({ db });
  const ends = new Map<string, PendingBuildEnd>();
  const end = runs.endPendingBuild.bind(runs);
  runs.endPendingBuild = (pendingId, value) => {
    ends.set(pendingId, value);
    end(pendingId, value);
  };
  return { runs, flows: new SqliteFlowStore({ db }), ends, close: () => db.close() };
}

export type LiveEngineOptions = {
  home: string;
  repo: string;
  stores?: LiveStores;
  sessionName?: string;
  publish?: (push: EnginePush) => void;
  waiter?: HumanWaiter;
  waits?: AppWaiter;
  buildAgents?: BuildAgents;
  kit?: EngineHandlerOptions["kit"];
  openSession?: (open: OpenSession) => OpenSession;
  startEvents?: (start: StartEvents) => StartEvents;
  sessionAlive?: (sessionName: string) => Promise<boolean>;
  buildTimeoutMs?: number;
};

export type BuildRequestOptions = {
  name: string;
  values?: VariableValues;
  buildModel?: string;
};

export type EndedBuild = {
  pendingId: string;
  outcome: PendingBuildEnd;
  workspaceDir: string | undefined;
  files: ReadonlyMap<string, string>;
};

export type LiveBuild = EndedBuild & {
  buildId: string;
  hash: string;
  dir: string;
  workFolder: string;
};

export type LiveEngine = {
  handler: EngineHandler;
  stores: LiveStores;
  waits: AppWaiter | undefined;
  sessionIds: string[];
  ask<T>(type: EngineRequest["type"], payload?: unknown): Promise<T>;
  saveAndEndBuild(flow: Flow, request: BuildRequestOptions): Promise<EndedBuild>;
  saveAndBuild(flow: Flow, request: BuildRequestOptions): Promise<LiveBuild>;
  runBuild(buildId: string, choices?: { auto?: boolean }): Promise<string>;
  waitForRunEnd(runId: string, timeoutMs: number): Promise<RunStatus>;
  stopRun(runId: string): Promise<void>;
  detach(): Promise<void>;
  cleanup(): Promise<void>;
};

export function liveEngine(options: LiveEngineOptions): LiveEngine {
  const { home, repo } = options;
  const savedTmux = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const stores = options.stores ?? openLiveStores(home);
  const fs = new NodeFileSystem();
  const publish = options.publish ?? (() => undefined);
  const waits =
    options.waiter === undefined
      ? (options.waits ?? createAppWaiter({ push: publish }))
      : undefined;
  const sessionIds: string[] = [];
  const sessionNames = new Set<string>();
  const workFolders = new Set<string>();
  const opened: BuildAgentsOpenSpec[] = [];
  const closedFiles = new Map<string, Map<string, string>>();
  const fakeBuild = fakeEngineBuildOptions(fs);
  const agents = options.buildAgents ?? fakeBuild.buildAgents;
  const base = liveEnvironment(fs);
  const recordedOpen: OpenSession = async (open) => {
    sessionNames.add(open.sessionName);
    workFolders.add(open.cwd);
    const session = await (options.openSession ?? ((inner: OpenSession) => inner))(
      base.openSession,
    )(open);
    sessionIds.push(session.sessionId);
    return session;
  };
  const transcriptOf = (id: string) =>
    new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(id);
  const handler = createEngineHandler({
    version: "live",
    openStores: () => stores,
    home,
    publish,
    prepareHooks: () => ({
      kind: "ok",
      nodePath: process.execPath,
      hookScriptPath,
      guardScriptPath,
      webGuardScriptPath: fileURLToPath(
        new URL("../../bin/flowdeck-web-guard.ts", import.meta.url),
      ),
    }),
    buildAgents: {
      open: async (spec) => {
        opened.push(spec);
        await agents.open(spec);
      },
      turn: (name, text, onCall) => agents.turn(name, text, onCall),
      alive: (name) => agents.alive(name),
      close: async (name) => {
        const spec = opened.find((open) => open.sessionName === name);
        if (spec !== undefined) closedFiles.set(name, await readWorkspace(spec.workspaceDir));
        await agents.close(name);
      },
    },
    kit: options.kit ?? fakeBuild.kit,
    connectors: new FakeConnectorSource(),
    isFolder: (folder) => statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
    fs,
    run: {
      ...base,
      startEvents: (options.startEvents ?? ((inner: StartEvents) => inner))(base.startEvents),
      openSession: recordedOpen,
      ...(options.waiter === undefined ? {} : { waiter: options.waiter }),
    },
    ...(waits === undefined ? {} : { waits }),
    ...(options.sessionAlive === undefined ? {} : { sessionAlive: options.sessionAlive }),
    ...(options.sessionName === undefined
      ? {}
      : { newSessionName: () => options.sessionName ?? "" }),
    worktree: new GitWorktree(),
    gitState: new GitFolderState(),
    transcriptTurns: async (id) => {
      const path = await transcriptOf(id);
      return path === undefined ? [] : parseTranscriptTurns(await readFile(path, "utf8"));
    },
  });

  let requestId = 0;
  const ask = async <T>(type: EngineRequest["type"], payload?: unknown): Promise<T> => {
    requestId += 1;
    const response = await handler.handle({ id: requestId, type, payload });
    if (!response.ok) throw new Error(`${type}: ${response.error}`);
    return response.value as T;
  };

  const saveAndEndBuild = async (
    flow: Flow,
    { name, values = {}, buildModel }: BuildRequestOptions,
  ): Promise<EndedBuild> => {
    const ref = stores.flows.save(flow);
    const before = opened.length;
    const started = await ask<{ kind: string; pendingId?: string }>("build-version", {
      ...ref,
      name,
      repo,
      values,
      ...(buildModel === undefined ? {} : { buildModel }),
    });
    const { pendingId } = started;
    if (started.kind !== "started" || pendingId === undefined) {
      throw new Error(`build ${name} did not start: ${JSON.stringify(started)}`);
    }
    await vi.waitFor(
      () => {
        if (!stores.ends.has(pendingId)) throw new Error(`build ${name} has not ended`);
      },
      { timeout: options.buildTimeoutMs ?? 60_000, interval: 250 },
    );
    const outcome = stores.ends.get(pendingId) as PendingBuildEnd;
    const spec = opened.slice(before).at(-1);
    const files = (spec && closedFiles.get(spec.sessionName)) ?? new Map<string, string>();
    console.log(
      [
        `build ${name} ended ${JSON.stringify(outcome)}`,
        `files: ${[...files.keys()].join(", ")}`,
      ].join("\n"),
    );
    return { pendingId, outcome, workspaceDir: spec?.workspaceDir, files };
  };

  const saveAndBuild = async (flow: Flow, request: BuildRequestOptions): Promise<LiveBuild> => {
    const ended = await saveAndEndBuild(flow, request);
    const record = stores.runs.findBuildByName(request.name);
    if (record === undefined) {
      throw new Error(`build ${request.name} ended ${JSON.stringify(ended.outcome)}, not built`);
    }
    const workFolder = workFolderOf(record.dir, repo);
    workFolders.add(workFolder);
    return { ...ended, buildId: record.id, hash: record.hash, dir: record.dir, workFolder };
  };

  const runBuild = async (buildId: string, choices: { auto?: boolean } = {}) => {
    const started = await ask<{ kind: string; runId?: string; message?: string }>("run-build", {
      buildId,
      ...choices,
    });
    if (started.kind !== "started" || started.runId === undefined) {
      throw new Error(`run of ${buildId} did not start: ${JSON.stringify(started)}`);
    }
    return started.runId;
  };

  const waitForRunEnd = async (runId: string, timeoutMs: number): Promise<RunStatus> => {
    await vi.waitFor(
      () => {
        if (stores.runs.findRun(runId)?.status === "running") throw new Error("still running");
      },
      { timeout: timeoutMs, interval: 500 },
    );
    const status = stores.runs.findRun(runId)?.status;
    if (status === undefined) throw new Error(`no run ${runId}`);
    return status;
  };

  const cleanup = async () => {
    await handler.stop().catch(() => undefined);
    if (options.stores === undefined) stores.close();
    for (const name of sessionNames) await killTmuxServer(name);
    for (const spec of opened) {
      await agents.close(spec.sessionName).catch(() => undefined);
      await killTmuxServer(spec.sessionName);
      await removeClaudeSessions(spec.workspaceDir, [spec.claudeSessionId]);
    }
    for (const folder of workFolders) await removeClaudeSessions(folder, sessionIds);
    for (const [key, value] of Object.entries(savedTmux)) {
      if (value !== undefined) process.env[key] = value;
    }
  };

  return {
    handler,
    stores,
    waits,
    sessionIds,
    ask,
    saveAndEndBuild,
    saveAndBuild,
    runBuild,
    waitForRunEnd,
    stopRun: async (runId) => {
      await ask("stop-run", { runId });
    },
    detach: () => handler.detach(),
    cleanup,
  };
}
