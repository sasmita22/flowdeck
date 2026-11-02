import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeSessionMcpConfig } from "../../adapters/claude/claude-connectors.js";
import type { BuildResult } from "../../core/compiler/build.js";
import { buildVersion } from "../../core/compiler/build-version.js";
import { resolveConnectors } from "../../core/compiler/connectors.js";
import { parseFlow } from "../../core/flow/schema.js";
import { workingFolderSchema, type FolderState } from "../../core/flow/workspace-info.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runMcpConfigPath,
  runSocketPath,
  type OpenedSession,
  type RunEnvironment,
} from "../../core/run/execute.js";
import { runSnapshot, type StartRunResult } from "../../core/run/snapshot.js";
import { waitAnswerSchema } from "../../core/run/wait.js";
import type { ConnectorSource } from "../../ports/connector-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import type {
  FlowStore,
  LoadLatestFlowResult,
  SaveFlowResult,
  SavedFlowRef,
} from "../../ports/flow-store.js";
import type { GitState } from "../../ports/git-state.js";
import type { Store } from "../../ports/store.js";
import type { Worktree } from "../../ports/worktree.js";
import { createActivityTracker } from "./activity-tracker.js";
import type { AppWaiter } from "./app-waiter.js";
import type { HooksResult } from "./hooks.js";
import type { EnginePush, EngineRequest, EngineResponse, StoreOpenResult } from "./protocol.js";
import { createPublishingStore } from "./publishing-store.js";

export type EngineStores = { runs: Store; flows: FlowStore };

export type EngineHandlerOptions = {
  version: string;
  openStores: () => EngineStores;
  home: string;
  publish: (push: EnginePush) => void;
  prepareHooks: () => HooksResult;
  isFolder: (path: string) => boolean;
  fs: FileSystem;
  connectors: ConnectorSource;
  run: RunEnvironment & { now: () => number };
  newSessionName?: () => string;
  waits?: Pick<AppWaiter, "answer" | "drop">;
  worktree: Worktree;
  gitState: GitState;
};

export type EngineHandler = {
  handle(request: EngineRequest): Promise<EngineResponse>;
  stop(): Promise<void>;
};

type ActiveRun = {
  runId: string;
  done: Promise<void>;
  interrupt?: (code: number) => void;
  stopRequested?: number;
};

type Opened = { kind: "ready"; stores: EngineStores } | { kind: "error"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceInfoPayload = z.object({ workingFolder: workingFolderSchema });

const inputsSchema = z.record(z.string(), z.string());

const startRunPayload = z.object({ inputs: inputsSchema.optional() }).optional();

const buildVersionPayload = z.object({ flowId: z.string(), version: z.number().int() });

const buildFilesPayload = z.object({ hash: z.string() });

const runBuildPayload = z.object({ hash: z.string(), inputs: inputsSchema.optional() });

export type BuildVersionResult =
  | {
      kind: "built";
      hash: string;
      dir: string;
      reused: boolean;
      restored: { path: string; problem: string }[];
    }
  | { kind: "error"; message: string };

export type BuildFileContent = { path: string; sha256: string; content: string };

const problemsOf = (result: Extract<BuildResult, { ok: false }>) =>
  result.errors.map((error) => `${error.rule}: ${error.message}`).join("\n");

function announced(
  opened: OpenedSession,
  sessionName: string,
  publish: (push: EnginePush) => void,
): OpenedSession {
  let isAnnounced = false;
  return {
    ...opened,
    session: {
      async ensureStarted() {
        await opened.session.ensureStarted();
        if (isAnnounced) return;
        isAnnounced = true;
        publish({ push: "session", value: sessionName });
      },
    },
    async stop() {
      if (isAnnounced) publish({ push: "session", value: null });
      await opened.stop();
    },
  };
}

export function createEngineHandler(options: EngineHandlerOptions): EngineHandler {
  let opened: Opened | undefined;

  const openStoresOnce = (): Opened => {
    if (opened !== undefined) return opened;
    try {
      opened = { kind: "ready", stores: options.openStores() };
    } catch (error) {
      opened = { kind: "error", message: messageOf(error) };
    }
    return opened;
  };

  const storeStatus = (): StoreOpenResult => {
    const result = openStoresOnce();
    return result.kind === "ready" ? { kind: "ready" } : result;
  };

  const saveFlow = (payload: unknown): SaveFlowResult => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    try {
      const saved = result.stores.flows.save(parseFlow(payload));
      return { kind: "saved", flowId: saved.flowId, version: saved.version };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  const loadLatestFlow = (): LoadLatestFlowResult => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    try {
      const latest = result.stores.flows.loadLatest();
      return latest === null ? { kind: "empty" } : { kind: "loaded", flow: latest.flow };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  const newSessionName = options.newSessionName ?? (() => `fd-run-${randomUUID().slice(0, 8)}`);
  let active: ActiveRun | undefined;
  let starting: Promise<StartRunResult> | undefined;

  const failure = (message: string): StartRunResult => ({ kind: "error", message });

  const oneAtATime = async (launch: () => Promise<StartRunResult>): Promise<StartRunResult> => {
    if (active !== undefined || starting !== undefined) {
      return failure("A run is already in progress");
    }
    starting = launch();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };

  const buildFlowVersion = async (
    stores: EngineStores,
    ref: SavedFlowRef,
  ): Promise<BuildVersionResult> => {
    const result = await buildVersion(ref, {
      flows: stores.flows,
      store: stores.runs,
      fs: options.fs,
      home: options.home,
      connectors: options.connectors,
    });
    if (!result.ok) return { kind: "error", message: problemsOf(result) };
    for (const { path, problem } of result.restored) {
      console.log(`engine: build ${result.hash} restored ${path} (${problem})`);
    }
    const { hash, dir, reused, restored } = result;
    return { kind: "built", hash, dir, reused, restored };
  };

  const withStores = async <T extends { kind: string }>(
    use: (stores: EngineStores) => Promise<T | { kind: "error"; message: string }>,
  ): Promise<T | { kind: "error"; message: string }> => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    try {
      return await use(result.stores);
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  const startRun = (inputs: Record<string, string>): Promise<StartRunResult> =>
    oneAtATime(() =>
      withStores(async (stores) => {
        const latest = stores.flows.loadLatest();
        if (latest === null) return failure("Save the flow before running it");
        const { flowId, version } = latest;
        const built = await buildFlowVersion(stores, { flowId, version });
        if (built.kind === "error") return built;
        return launchBuild(stores, built.hash, inputs);
      }),
    );

  const runBuild = (hash: string, inputs: Record<string, string>): Promise<StartRunResult> =>
    oneAtATime(() => withStores((stores) => launchBuild(stores, hash, inputs)));

  const launchBuild = async (
    stores: EngineStores,
    hash: string,
    inputs: Record<string, string>,
  ): Promise<StartRunResult> => {
    const { runs } = stores;
    const built = runs.findBuild(hash);
    if (built === undefined) return failure(`No build ${hash}`);
    const loaded = await loadBuild(built.dir, { fs: options.fs });
    if (loaded.kind === "error") return failure(loaded.message);
    const manifest = loaded.build;
    const connectors = await resolveConnectors(manifest.session.connectors, options.connectors);
    if (!connectors.ok) return failure(problemsOf(connectors));
    const folder = manifest.session.workingFolder;
    if (folder.kind === "worktree") {
      if (!folder.repo) {
        return failure("Set the session's repository before running a fresh worktree");
      }
    } else if (!options.isFolder(folder.path)) {
      return failure(`Working folder not found: ${folder.path}`);
    }
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failure(hooks.message);
    const sessionName = newSessionName();
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") return failure(socket.message);
    const claudeSessionId = randomUUID();
    let cwd: string;
    if (folder.kind === "worktree") {
      const id8 = claudeSessionId.slice(0, 8);
      cwd = join(options.home, "worktrees", id8);
      await options.worktree.add({
        repo: folder.repo ?? "",
        base: folder.branch,
        branch: `flowdeck/${id8}`,
        path: cwd,
      });
      if (!options.isFolder(cwd)) return failure(`Working folder not found: ${cwd}`);
    } else {
      cwd = folder.path;
    }
    const nodeIds = manifest.nodes.map((node) => node.id);
    const { id: runId } = runs.createRun({
      buildDir: built.dir,
      inputs,
      nodeIds,
      session: { tmuxName: sessionName, cwd, claudeSessionId },
      buildHash: built.hash,
    });
    options.publish({
      push: "run-state",
      value: runSnapshot({ runId, status: "running", nodeIds, events: [] }),
    });
    const tracker = createActivityTracker({
      runId,
      now: options.run.now,
      publish: options.publish,
      log: (line) => console.log(`engine: activity ${line}`),
    });
    const store = createPublishingStore({
      store: tracker.store(runs),
      runId,
      nodeIds,
      publish: options.publish,
    });
    const run: ActiveRun = { runId, done: Promise.resolve() };
    run.done = execute(
      {
        ...options.run,
        store,
        startEvents: async (path) => {
          const started = await options.run.startEvents(path);
          const unwatch = tracker.watch(started.events, claudeSessionId);
          return {
            ...started,
            stop: async () => {
              unwatch();
              await started.stop();
            },
          };
        },
        onChange: (line) => console.log(`engine: ${line}`),
        onInterrupt: (handler) => {
          run.interrupt = handler;
          if (run.stopRequested !== undefined) handler(run.stopRequested);
          return () => {
            delete run.interrupt;
          };
        },
      },
      {
        store,
        runId,
        manifest,
        cwd,
        auto: false,
        socketPath: socket.path,
        open: async () =>
          needsClaude(manifest)
            ? announced(
                await options.run.openSession({
                  sessionName,
                  buildDir: built.dir,
                  model: manifest.session.model,
                  socketPath: socket.path,
                  cwd,
                  claudeSessionId,
                  hooks: { nodePath: hooks.nodePath, hookScriptPath: hooks.hookScriptPath },
                  ...(await writeSessionMcpConfig(
                    options.fs,
                    runMcpConfigPath(options.home, runId),
                    connectors.servers,
                  )),
                }),
                sessionName,
                options.publish,
              )
            : noClaude,
      },
    )
      .then(
        () => undefined,
        (error: unknown) => {
          console.log(`engine: run ${runId} error ${messageOf(error)}`);
          if (runs.findRun(runId)?.status === "running") store.finishRun(runId, "failed");
        },
      )
      .catch((error: unknown) => {
        console.log(`engine: run ${runId} finish error ${messageOf(error)}`);
      })
      .finally(() => {
        options.waits?.drop();
        active = undefined;
        try {
          console.log(`engine: run ${runId} ${runs.findRun(runId)?.status ?? "unknown"}`);
        } catch (error) {
          console.log(`engine: run ${runId} unknown (${messageOf(error)})`);
        }
      });
    active = run;
    console.log(`engine: run ${runId} started`);
    return { kind: "started", runId };
  };

  const buildFiles = async (stores: EngineStores, hash: string): Promise<BuildFileContent[]> => {
    const built = stores.runs.findBuild(hash);
    if (built === undefined) throw new Error(`No build ${hash}`);
    return Promise.all(
      stores.runs.buildFiles(hash).map(async (file) => ({
        ...file,
        content: await options.fs.readFile(`${built.dir}/${file.path}`),
      })),
    );
  };

  const storesOrThrow = (): EngineStores => {
    const result = openStoresOnce();
    if (result.kind === "error") throw new Error(result.message);
    return result.stores;
  };

  return {
    async stop() {
      await starting;
      const run = active;
      if (run === undefined) return;
      if (run.interrupt === undefined) run.stopRequested = 143;
      else run.interrupt(143);
      await run.done;
    },
    async handle(request) {
      switch (request.type) {
        case "version":
          return { id: request.id, ok: true, value: options.version };
        case "store-status":
          return { id: request.id, ok: true, value: storeStatus() };
        case "save-flow":
          return { id: request.id, ok: true, value: saveFlow(request.payload) };
        case "load-latest-flow":
          return { id: request.id, ok: true, value: loadLatestFlow() };
        case "start-run": {
          const parsed = startRunPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          return { id: request.id, ok: true, value: await startRun(parsed.data?.inputs ?? {}) };
        }
        case "build-version": {
          const parsed = buildVersionPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const value = await withStores((stores) => buildFlowVersion(stores, parsed.data));
          return { id: request.id, ok: true, value };
        }
        case "list-builds":
          try {
            return { id: request.id, ok: true, value: storesOrThrow().runs.listBuilds() };
          } catch (error) {
            return { id: request.id, ok: false, error: messageOf(error) };
          }
        case "build-files": {
          const parsed = buildFilesPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          try {
            return {
              id: request.id,
              ok: true,
              value: await buildFiles(storesOrThrow(), parsed.data.hash),
            };
          } catch (error) {
            return { id: request.id, ok: false, error: messageOf(error) };
          }
        }
        case "run-build": {
          const parsed = runBuildPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const value = await runBuild(parsed.data.hash, parsed.data.inputs ?? {});
          return { id: request.id, ok: true, value };
        }
        case "workspace-info": {
          const parsed = workspaceInfoPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const folder = parsed.data.workingFolder;
          try {
            const value: FolderState | null =
              folder.kind === "path" ? await options.gitState.read(folder.path) : null;
            return { id: request.id, ok: true, value };
          } catch (error) {
            return { id: request.id, ok: false, error: messageOf(error) };
          }
        }
        case "answer-wait": {
          const parsed = waitAnswerSchema.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          return {
            id: request.id,
            ok: true,
            value: { accepted: options.waits?.answer(parsed.data) ?? false },
          };
        }
      }
    },
  };
}
