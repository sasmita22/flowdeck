import { randomUUID } from "node:crypto";
import { build, type BuildFileSystem } from "../../core/compiler/build.js";
import type { VerifyFileSystem } from "../../core/compiler/verify.js";
import { parseFlow } from "../../core/flow/schema.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runSocketPath,
  type OpenedSession,
  type RunEnvironment,
} from "../../core/run/execute.js";
import { runSnapshot, type StartRunResult } from "../../core/run/snapshot.js";
import type { FlowStore, LoadLatestFlowResult, SaveFlowResult } from "../../ports/flow-store.js";
import type { Store } from "../../ports/store.js";
import { createActivityTracker } from "./activity-tracker.js";
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
  fs: BuildFileSystem & VerifyFileSystem;
  run: RunEnvironment & { now: () => number };
  newSessionName?: () => string;
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

  const startRun = async (): Promise<StartRunResult> => {
    if (active !== undefined || starting !== undefined) {
      return failure("A run is already in progress");
    }
    starting = launchRun();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };

  const launchRun = async (): Promise<StartRunResult> => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    const { runs, flows } = result.stores;
    try {
      const latest = flows.loadLatest();
      if (latest === null) return failure("Save the flow before running it");
      const { flow } = latest;
      const folder = flow.session.workingFolder;
      if (folder.kind === "worktree") {
        return failure(
          "Set a working folder before running (worktree folders are not supported yet)",
        );
      }
      if (!options.isFolder(folder.path)) {
        return failure(`Working folder not found: ${folder.path}`);
      }
      const hooks = options.prepareHooks();
      if (hooks.kind === "error") return failure(hooks.message);
      const built = await build(flow, {
        fs: options.fs,
        home: options.home,
        hooks: { nodePath: hooks.nodePath, hookScriptPath: hooks.hookScriptPath },
      });
      if (!built.ok) {
        return failure(built.errors.map((error) => `${error.rule}: ${error.message}`).join("\n"));
      }
      runs.recordBuild({ hash: built.hash, dir: built.dir });
      const loaded = await loadBuild(built.dir, { fs: options.fs });
      if (loaded.kind === "error") return failure(loaded.message);
      const manifest = loaded.build;
      const sessionName = newSessionName();
      const socket = runSocketPath(options.home, sessionName);
      if (socket.kind === "error") return failure(socket.message);
      const cwd = folder.path;
      const claudeSessionId = randomUUID();
      const nodeIds = manifest.nodes.map((node) => node.id);
      const { id: runId } = runs.createRun({
        buildDir: built.dir,
        inputs: {},
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
              events: started.events,
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
    } catch (error) {
      return failure(messageOf(error));
    }
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
        case "start-run":
          return { id: request.id, ok: true, value: await startRun() };
      }
    },
  };
}
