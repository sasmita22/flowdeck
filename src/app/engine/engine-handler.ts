import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeSessionMcpConfig } from "../../adapters/claude/claude-connectors.js";
import type { BuildResult } from "../../core/compiler/build.js";
import { buildVersion } from "../../core/compiler/build-version.js";
import { resolveConnectors } from "../../core/compiler/connectors.js";
import { plainProblems, type Problem } from "../../core/compiler/problems.js";
import type { ValidationError } from "../../core/compiler/validate.js";
import { diagnoseConnectors, type DoctorReport } from "../../core/doctor/connectors.js";
import type { OpenedFlow } from "../../core/flow/flow-store.js";
import { BuildConfig, parseFlow, type Flow } from "../../core/flow/schema.js";
import type { VariableValues } from "../../core/flow/variables.js";
import { SessionGoneError } from "../../adapters/claude/claude-session.js";
import { agentNodes, chargeUsage, costReport, type CostReport } from "../../core/run/cost.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runMcpConfigPath,
  runSocketPath,
  turnNodeIds,
  type LoadedBuild,
  type OpenedSession,
  type RunEnvironment,
} from "../../core/run/execute.js";
import {
  optionsClash,
  runChoices,
  storedAuto,
  storedFlags,
  storedOptions,
  type RunChoices,
} from "../../core/run/options.js";
import { deleteBuild, type DeleteBuildResult } from "../../core/run/delete-build.js";
import { decideResume, type TranscriptTurn } from "../../core/run/resume.js";
import { resumeEntries, retryEntries } from "../../core/run/retry.js";
import type { BuildRecord, EventEntry, StoredEvent } from "../../core/run/store.js";
import type {
  BuildFileContent,
  BuildVersionResult,
  ListedRun,
  LoadedRun,
} from "../../core/run/listing.js";
import { runSnapshot, type StartRunResult } from "../../core/run/snapshot.js";
import { waitAnswerSchema, type HumanWaiter } from "../../core/run/wait.js";
import type { ConnectorSource } from "../../ports/connector-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import type { FlowStore, SaveFlowResult, SavedFlowRef } from "../../ports/flow-store.js";
import type { GitState } from "../../ports/git-state.js";
import type { RunSummary, Store } from "../../ports/store.js";
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
  userHome?: string;
  publish: (push: EnginePush) => void;
  prepareHooks: () => HooksResult;
  isFolder: (path: string) => boolean;
  fs: FileSystem;
  connectors: ConnectorSource;
  run: Omit<RunEnvironment, "waiter"> & { waiter?: HumanWaiter; now: () => number };
  newSessionName?: () => string;
  waits?: AppWaiter;
  worktree: Worktree;
  gitState: GitState;
  transcriptTurns: (claudeSessionId: string) => Promise<TranscriptTurn[]>;
  sessionAlive?: (sessionName: string) => Promise<boolean>;
  endSession?: (sessionName: string) => Promise<void>;
  homeLock?: { acquire(): Promise<boolean> };
};

export type EngineHandler = {
  handle(request: EngineRequest): Promise<EngineResponse>;
  stop(): Promise<void>;
  detach(): Promise<void>;
  reattach(): Promise<void>;
};

type ActiveRun = {
  runId: string;
  buildId: string;
  done: Promise<void>;
  interrupt?: (code: number) => void;
  stopRequested?: number;
  detached?: boolean;
  stopEvents?: () => Promise<void>;
  claudeCalls: Set<Promise<unknown>>;
};

type Opened = { kind: "ready"; stores: EngineStores } | { kind: "error"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceInfoPayload = z.object({ buildConfig: BuildConfig });

const buildVersionPayload = z.object({
  flowId: z.string(),
  version: z.number().int(),
  name: z.string(),
  repo: z.string().optional(),
  base: z.string().optional(),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

const buildIdPayload = z.object({ buildId: z.string() });

const repoPayload = z.object({ repo: z.string() });

const savePayload = z.object({
  flowId: z.string().nullable(),
  name: z.string().optional(),
  flow: z.unknown(),
});

const renameFlowPayload = z.object({ flowId: z.string(), name: z.string() });

const openFlowPayload = z.object({ flowId: z.string().optional() });

const loadRunPayload = z.object({ runId: z.string() });

const doctorPayload = z.object({ connectors: z.array(z.string()) });

const runBuildPayload = z.object({ buildId: z.string(), auto: z.boolean().optional() });

const runIdPayload = z.object({ runId: z.string() });

const retryPayload = z.object({ runId: z.string(), nodeId: z.string() });

const sessionGone =
  "This run's Claude session ended just now. Resume again to start Claude on the same conversation.";

const closedNote =
  "Flowdeck closed while this run was going. Resume carries on from where it stopped.";

const sessionEndedNote =
  "Flowdeck closed while this run was going, and its Claude session has ended since. Resume starts Claude again on the same conversation.";

const detachWaitMs = 8_000;

const detachedError = () => new Error("Flowdeck is closing; the run carries on without it");

function detachable(store: Store, detached: () => boolean): Store {
  return {
    createRun: (run) => store.createRun(run),
    findRun: (id) => store.findRun(id),
    listRuns: () => store.listRuns(),
    events: (id) => store.events(id),
    activity: (id) => store.activity(id),
    findBuild: (id) => store.findBuild(id),
    findBuildByName: (name) => store.findBuildByName(name),
    listBuilds: () => store.listBuilds(),
    buildFiles: (id) => store.buildFiles(id),
    recordBuild: (build) => store.recordBuild(build),
    deleteBuild: (id) => store.deleteBuild(id),
    append(id, nodeId, event) {
      if (!detached()) store.append(id, nodeId, event);
    },
    appendAll(id, entries) {
      if (!detached()) store.appendAll(id, entries);
    },
    finishRun(id, status) {
      if (!detached()) store.finishRun(id, status);
    },
    reopenRun(id) {
      if (!detached()) store.reopenRun(id);
    },
    stopRun(id) {
      if (!detached()) store.stopRun(id);
    },
    recordActivity(id, entry) {
      if (!detached()) store.recordActivity(id, entry);
    },
    recordCost(id, totalCost) {
      if (!detached()) store.recordCost(id, totalCost);
    },
  };
}

type Continuation = { kind: "retry"; nodeId: string } | { kind: "resume" };

export type BuiltVersion =
  | { kind: "built"; id: string; hash: string; dir: string }
  | Extract<BuildVersionResult, { kind: "error" }>;

export type ListedBuild = BuildRecord & { old: boolean };

export type { BuildFileContent };

const saveTo = (
  flows: FlowStore,
  flowId: string | null,
  name: string | undefined,
  flow: Flow,
): SavedFlowRef => flows.save(flow, flowId ?? { name: name ?? "Untitled" });

const problemText = ({ node, text }: Problem) => (node === undefined ? text : `${node}: ${text}`);

const problemsOf = (result: { errors: readonly ValidationError[] }) =>
  plainProblems(result.errors).map(problemText).join("\n");

const refusedBuild = (result: Extract<BuildResult, { ok: false }>): BuiltVersion => {
  const problems = plainProblems(result.errors);
  return { kind: "error", message: problems.map(problemText).join("\n"), problems };
};

const isOld = (build: BuildRecord) => build.name === null;

const isRepo = (state: { kind: string }) => state.kind === "branch" || state.kind === "detached";

function announced(
  opened: OpenedSession,
  runId: string,
  sessionName: string,
  publish: (push: EnginePush) => void,
  running = false,
): OpenedSession {
  let isAnnounced = running;
  if (running) publish({ push: "session", runId, value: sessionName });
  return {
    ...opened,
    session: {
      async ensureStarted() {
        await opened.session.ensureStarted();
        if (isAnnounced) return;
        isAnnounced = true;
        publish({ push: "session", runId, value: sessionName });
      },
    },
    async stop() {
      if (isAnnounced) publish({ push: "session", runId, value: null });
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
      const { flowId, name, flow } = savePayload.parse(payload);
      const saved = saveTo(result.stores.flows, flowId, name, parseFlow(flow));
      return { kind: "saved", flowId: saved.flowId, version: saved.version };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  const newSessionName = options.newSessionName ?? (() => `fd-run-${randomUUID().slice(0, 8)}`);
  const active = new Map<string, ActiveRun>();
  const starting = new Map<string, Promise<StartRunResult>>();
  const deleting = new Set<string>();
  const notes = new Map<string, string>();
  const sessionAlive = options.sessionAlive ?? (async () => false);

  const failure = (message: string): StartRunResult => ({ kind: "error", message });

  const oneAtATime = async (
    buildId: string,
    launch: () => Promise<StartRunResult>,
  ): Promise<StartRunResult> => {
    if (active.has(buildId) || starting.has(buildId)) {
      return failure("A run of this build is already in progress");
    }
    if (deleting.has(buildId)) return failure("This build is being deleted");
    const launching = launch();
    starting.set(buildId, launching);
    try {
      return await launching;
    } finally {
      starting.delete(buildId);
    }
  };

  const startsSettled = () => Promise.allSettled(starting.values());

  const activeRun = (runId: string) => [...active.values()].find((run) => run.runId === runId);

  const waiterFor = (runId: string): HumanWaiter => {
    const waiter = options.waits?.forRun(runId) ?? options.run.waiter;
    if (waiter === undefined) throw new Error("The engine has no waiter for a run's questions");
    return waiter;
  };

  const buildFlowVersion = async (
    stores: EngineStores,
    { flowId, version, ...request }: z.infer<typeof buildVersionPayload>,
  ): Promise<BuiltVersion> => {
    const result = await buildVersion(
      { flowId, version },
      {
        name: request.name,
        values: request.values as VariableValues,
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.base === undefined ? {} : { base: request.base }),
      },
      {
        flows: stores.flows,
        store: stores.runs,
        fs: options.fs,
        home: options.home,
        connectors: options.connectors,
        gitState: options.gitState,
        worktree: options.worktree,
        newId: randomUUID,
      },
    );
    if (!result.ok) return refusedBuild(result);
    return { kind: "built", id: result.record.id, hash: result.hash, dir: result.dir };
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

  type Execution = {
    stores: EngineStores;
    runId: string;
    buildId: string;
    manifest: LoadedBuild;
    nodeIds: readonly string[];
    cwd: string;
    socketPath: string;
    claudeSessionId: string;
    stored: Record<string, unknown>;
    open: () => Promise<OpenedSession>;
    actions?: () => Promise<ReturnType<typeof decideResume>>;
  };

  const startExecution = (launch: Execution): StartRunResult => {
    const run: ActiveRun = {
      runId: launch.runId,
      buildId: launch.buildId,
      done: Promise.resolve(),
      claudeCalls: new Set(),
    };
    const isDetached = () => run.detached === true;
    const runs = detachable(launch.stores.runs, isDetached);
    const { runId, manifest, nodeIds, claudeSessionId } = launch;
    const unlessDetached = <T>(step: () => Promise<T>): Promise<T> =>
      isDetached() ? Promise.reject(detachedError()) : step();
    const claudeCall = <T>(step: () => Promise<T>): Promise<T> => {
      const call = unlessDetached(step);
      run.claudeCalls.add(call);
      const forget = () => run.claudeCalls.delete(call);
      call.then(forget, forget);
      return call;
    };
    const { scripts } = options.run;
    let eventsFailed = false;
    const continuesEarlierRun = launch.actions !== undefined;
    const tracker = createActivityTracker({
      runId,
      now: options.run.now,
      publish: options.publish,
      log: (line) => console.log(`engine: activity ${line}`),
      activity: runs,
      turnNodes: turnNodeIds(manifest),
      place:
        options.userHome === undefined
          ? { cwd: launch.cwd }
          : { cwd: launch.cwd, home: options.userHome },
    });
    const store = createPublishingStore({
      store: tracker.store(runs),
      runId,
      nodeIds,
      publish: options.publish,
    });
    run.done = execute(
      {
        ...options.run,
        waiter: waiterFor(runId),
        store,
        scripts: {
          run: (command, args, cwd, signal, job) =>
            unlessDetached(() => scripts.run(command, args, cwd, signal, job)),
          ...(scripts.rejoin === undefined
            ? {}
            : {
                rejoin: (job: string, signal?: AbortSignal) =>
                  unlessDetached(async () => scripts.rejoin?.(job, signal)),
              }),
        },
        startEvents: async (path) => {
          const started = await options.run.startEvents(path).catch((error: unknown) => {
            eventsFailed = true;
            throw error;
          });
          const unwatch = tracker.watch(started.events, claudeSessionId);
          const stopEvents = async () => {
            unwatch();
            await started.stop();
          };
          run.stopEvents = stopEvents;
          return { ...started, stop: stopEvents };
        },
        onChange: (line) => console.log(`engine: ${line}`),
        onOutput: (nodeId, stream, text) => tracker.output(nodeId, stream, text),
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
        cwd: launch.cwd,
        auto: storedAuto(launch.stored),
        flags: storedFlags(launch.stored, manifest),
        socketPath: launch.socketPath,
        scriptJobs: join(options.home, "runs", runId, "scripts"),
        open: async () => {
          const opened = await launch.open();
          return {
            ...opened,
            session: {
              ensureStarted: () => claudeCall(() => opened.session.ensureStarted()),
            },
            prompts: {
              sendPrompt: (text) => claudeCall(() => opened.prompts.sendPrompt(text)),
              interrupt: () => claudeCall(() => opened.prompts.interrupt()),
            },
            stop: () => (isDetached() ? Promise.resolve() : opened.stop()),
          };
        },
        ...(launch.actions === undefined ? {} : { actions: launch.actions }),
      },
    )
      .then(
        () => undefined,
        (error: unknown) => {
          console.log(`engine: run ${runId} error ${messageOf(error)}`);
          if (eventsFailed && continuesEarlierRun) return;
          if (runs.findRun(runId)?.status === "running") store.finishRun(runId, "failed");
        },
      )
      .catch((error: unknown) => {
        console.log(`engine: run ${runId} finish error ${messageOf(error)}`);
      })
      .finally(() => {
        if (isDetached()) return;
        options.waits?.drop(runId);
        if (active.get(run.buildId) === run) active.delete(run.buildId);
        try {
          console.log(`engine: run ${runId} ${runs.findRun(runId)?.status ?? "unknown"}`);
        } catch (error) {
          console.log(`engine: run ${runId} unknown (${messageOf(error)})`);
        }
      });
    active.set(run.buildId, run);
    console.log(`engine: run ${runId} started`);
    return { kind: "started", runId };
  };

  const sessionOptions = async (
    runId: string,
    manifest: LoadedBuild,
    buildDir: string,
    session: { sessionName: string; socketPath: string; cwd: string; claudeSessionId: string },
    hooks: Extract<HooksResult, { kind: "ok" }>,
    servers: Parameters<typeof writeSessionMcpConfig>[2],
  ) => ({
    ...session,
    buildDir,
    layout: manifest.layout,
    model: manifest.session.model,
    hooks: { nodePath: hooks.nodePath, hookScriptPath: hooks.hookScriptPath },
    ...(await writeSessionMcpConfig(options.fs, runMcpConfigPath(options.home, runId), servers)),
  });

  type RunBuildOptions = Omit<z.infer<typeof runBuildPayload>, "buildId">;

  const runBuild = (buildId: string, choices: RunBuildOptions): Promise<StartRunResult> =>
    oneAtATime(buildId, () => withStores((stores) => launchBuild(stores, buildId, choices)));

  const launchBuild = async (
    stores: EngineStores,
    buildId: string,
    choices: RunBuildOptions,
  ): Promise<StartRunResult> => {
    const { runs } = stores;
    const built = runs.findBuild(buildId);
    if (built === undefined) return failure(`No build ${buildId}`);
    if (built.deletedAt !== null) return failure(`Build ${built.name ?? buildId} was deleted.`);
    if (isOld(built)) {
      return failure(
        "This build was made before builds had names and a workspace. Make a new build from this blueprint to run it.",
      );
    }
    if (runs.listRuns().some((run) => run.buildId === buildId && run.status === "running")) {
      return failure("This build has a run left going. Stop or resume it first.");
    }
    const loaded = await loadBuild(buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") return failure(loaded.message);
    const manifest = loaded.build;
    const connectors = await resolveConnectors(manifest.session.connectors, options.connectors);
    if (!connectors.ok) return failure(problemsOf(connectors));
    const cwd = manifest.worktree;
    if (cwd === undefined || !options.isFolder(cwd)) {
      return failure(`Working folder not found: ${cwd ?? built.dir}`);
    }
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failure(hooks.message);
    const sessionName = newSessionName();
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") return failure(socket.message);
    const claudeSessionId = randomUUID();
    const nodeIds = manifest.nodes.map((node) => node.id);
    const stored = storedOptions({ inputs: {}, flags: {}, auto: choices.auto ?? false });
    const { id: runId } = runs.createRun({
      buildDir: built.dir,
      inputs: stored,
      nodeIds,
      session: { tmuxName: sessionName, cwd, claudeSessionId },
      buildId,
    });
    options.publish({
      push: "run-state",
      value: runSnapshot({ runId, status: "running", nodeIds, events: [] }),
    });
    const session = { sessionName, socketPath: socket.path, cwd, claudeSessionId };
    return startExecution({
      stores,
      runId,
      buildId,
      manifest,
      nodeIds,
      cwd,
      socketPath: socket.path,
      claudeSessionId,
      stored,
      open: async () =>
        needsClaude(manifest)
          ? announced(
              await options.run.openSession(
                await sessionOptions(
                  runId,
                  manifest,
                  built.dir,
                  session,
                  hooks,
                  connectors.servers,
                ),
              ),
              runId,
              sessionName,
              options.publish,
            )
          : noClaude,
    });
  };

  const continueRun = async (runId: string, how: Continuation): Promise<StartRunResult> => {
    let buildId: string | undefined;
    try {
      buildId = storesOrThrow().runs.findRun(runId)?.buildId;
    } catch (error) {
      return failure(messageOf(error));
    }
    if (buildId === undefined) return failure(`No run ${runId}`);
    const ofBuild = buildId;
    return oneAtATime(ofBuild, () =>
      withStores((stores) => launchContinuation(stores, runId, ofBuild, how)),
    );
  };

  const launchContinuation = async (
    stores: EngineStores,
    runId: string,
    buildId: string,
    how: Continuation,
  ): Promise<StartRunResult> => {
    const { runs } = stores;
    const record = runs.findRun(runId);
    const summary = runs.listRuns().find((candidate) => candidate.id === runId);
    if (record === undefined || summary === undefined) return failure(`No run ${runId}`);
    const status = listed(summary).status;
    if (how.kind === "resume" && status !== "stopped" && status !== "interrupted") {
      return failure("Only a stopped or interrupted run can be resumed");
    }
    const loaded = await loadBuild(buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") return failure(loaded.message);
    const manifest = loaded.build;
    const events = runs.events(runId);
    let entries: EventEntry[];
    try {
      entries =
        how.kind === "retry"
          ? retryEntries(manifest, events, how.nodeId)
          : status === "stopped"
            ? resumeEntries(manifest, events)
            : [];
    } catch (error) {
      return failure(messageOf(error));
    }
    const { tmuxName: sessionName, cwd, claudeSessionId } = record.session;
    const sentBefore = needsClaude(manifest) && events.some((event) => event.kind === "sent");
    const restart = sentBefore && !(await sessionAlive(sessionName));
    const decide = async (after: readonly StoredEvent[]) =>
      decideResume({
        manifest,
        events: after,
        turns: await options.transcriptTurns(claudeSessionId),
        rejoinScripts: true,
        sessionRestarted: restart,
      });
    const pending = entries.map(({ nodeId, event }, index): StoredEvent => ({
      ...event,
      nodeId,
      seq: -index,
      time: "",
    }));
    try {
      await decide([...events, ...pending]);
    } catch (error) {
      return failure(messageOf(error));
    }
    const connectors = await resolveConnectors(manifest.session.connectors, options.connectors);
    if (!connectors.ok) return failure(problemsOf(connectors));
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failure(hooks.message);
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") return failure(socket.message);
    let opened: OpenedSession = noClaude;
    if (needsClaude(manifest)) {
      const attach = sentBefore && !restart;
      try {
        opened = announced(
          await options.run.openSession({
            ...(await sessionOptions(
              runId,
              manifest,
              record.buildDir,
              { sessionName, socketPath: socket.path, cwd, claudeSessionId },
              hooks,
              connectors.servers,
            )),
            ...(attach ? { attach: true } : {}),
            ...(restart ? { resume: true } : {}),
          }),
          runId,
          sessionName,
          options.publish,
          attach,
        );
      } catch (error) {
        return failure(error instanceof SessionGoneError ? sessionGone : messageOf(error));
      }
    }
    if (entries.length > 0) runs.appendAll(runId, entries);
    runs.reopenRun(runId);
    notes.delete(runId);
    options.publish({
      push: "run-state",
      value: runSnapshot({
        runId,
        status: "running",
        nodeIds: record.nodeIds,
        events: runs.events(runId),
      }),
    });
    return startExecution({
      stores,
      runId,
      buildId,
      manifest,
      nodeIds: record.nodeIds,
      cwd,
      socketPath: socket.path,
      claudeSessionId,
      stored: record.inputs,
      open: async () => opened,
      actions: () => decide(runs.events(runId)),
    });
  };

  const reattach = async (): Promise<void> => {
    if (options.homeLock !== undefined && !(await options.homeLock.acquire())) {
      console.log(`engine: another Flowdeck holds ${options.home}; not reattaching`);
      return;
    }
    const result = openStoresOnce();
    if (result.kind === "error") return;
    const { runs } = result.stores;
    const left = runs
      .listRuns()
      .filter((run) => run.status === "running" && !isActive(run.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const { id: runId } of left) {
      try {
        await reattachRun(runs, runId);
      } catch (error) {
        console.log(`engine: run ${runId} not reattached (${messageOf(error)})`);
        notes.set(runId, `${closedNote} It could not be picked up again: ${messageOf(error)}`);
      }
    }
  };

  const reattachRun = async (runs: Store, runId: string): Promise<void> => {
    const record = runs.findRun(runId);
    if (record?.buildId === undefined) return;
    const loaded = await loadBuild(record.buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") {
      notes.set(runId, `${closedNote} Its build cannot be read: ${loaded.message}`);
      return;
    }
    const sent = runs.events(runId).some((event) => event.kind === "sent");
    if (needsClaude(loaded.build) && sent && !(await sessionAlive(record.session.tmuxName))) {
      console.log(`engine: run ${runId} interrupted, its session has ended`);
      notes.set(runId, sessionEndedNote);
      return;
    }
    const picked = await continueRun(runId, { kind: "resume" });
    if (picked.kind === "error") {
      console.log(`engine: run ${runId} not reattached (${picked.message})`);
      notes.set(runId, `${closedNote} It could not be picked up again: ${picked.message}`);
      return;
    }
    console.log(`engine: run ${runId} reattached`);
  };

  const claudeCallsSettled = async ({ runId, claudeCalls }: ActiveRun): Promise<void> => {
    if (claudeCalls.size === 0) return;
    console.log(
      `engine: run ${runId} detach waits up to ${detachWaitMs} ms for ${claudeCalls.size} Claude call(s)`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled(claudeCalls).then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), detachWaitMs))),
    ]);
    clearTimeout(timer);
    if (!settled) {
      console.log(`engine: run ${runId} detach gave up after ${detachWaitMs} ms on Claude calls`);
    }
  };

  const detach = async (): Promise<void> => {
    await startsSettled();
    await Promise.all(
      [...active.values()].map(async (run) => {
        run.detached = true;
        await claudeCallsSettled(run);
        await run.stopEvents?.();
      }),
    );
  };

  const stopActive = async (run: ActiveRun): Promise<void> => {
    if (run.interrupt === undefined) run.stopRequested = 143;
    else run.interrupt(143);
    await run.done;
  };

  const stopRun = async (runId: string): Promise<{ stopped: boolean }> => {
    await startsSettled();
    const run = activeRun(runId);
    if (run !== undefined) {
      await stopActive(run);
      return { stopped: true };
    }
    const { runs } = storesOrThrow();
    const record = runs.findRun(runId);
    if (record?.status !== "running") return { stopped: false };
    runs.stopRun(runId);
    const { tmuxName } = record.session;
    if (tmuxName.startsWith("fd-") && (await sessionAlive(tmuxName))) {
      await options.endSession?.(tmuxName);
    }
    return { stopped: true };
  };

  const choicesOf = async ({ runs }: EngineStores, buildId: string): Promise<RunChoices> => {
    const loaded = await loadBuild(buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") throw new Error(loaded.message);
    const clash = optionsClash(loaded.build);
    if (clash !== undefined) throw new Error(clash);
    return runChoices(loaded.build);
  };

  const runCost = async ({ runs }: EngineStores, runId: string): Promise<CostReport> => {
    const record = runs.findRun(runId);
    if (record?.buildId === undefined) throw new Error(`No run ${runId}`);
    const loaded = await loadBuild(record.buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") throw new Error(loaded.message);
    const events = runs.events(runId);
    const live = isActive(runId);
    const usage = options.run.usage;
    const pending =
      live && usage !== undefined
        ? chargeUsage({
            events,
            entries: await usage.entries(record.session.claudeSessionId),
            turnNodes: turnNodeIds(loaded.build),
            agentNodes: agentNodes(loaded.build),
          })
        : [];
    const last = events.at(-1);
    const now = live || last === undefined ? options.run.now() : Date.parse(last.time);
    return costReport({ nodeIds: record.nodeIds, events, pending, now });
  };

  const buildFiles = async (stores: EngineStores, buildId: string): Promise<BuildFileContent[]> => {
    const built = stores.runs.findBuild(buildId);
    if (built === undefined) throw new Error(`No build ${buildId}`);
    return Promise.all(
      stores.runs.buildFiles(buildId).map(async (file) => ({
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

  const openFlow = ({ flows }: EngineStores, flowId: string | undefined): OpenedFlow | null => {
    const latest = flows.loadLatest(flowId);
    if (latest !== null) {
      const { name, version, flow } = latest;
      return { flowId: latest.flowId, name, version, flow };
    }
    if (flowId === undefined) return null;
    const found = flows.list().find((summary) => summary.flowId === flowId);
    if (found === undefined) throw new Error(`No blueprint ${flowId}`);
    return { flowId, name: found.name, version: null, flow: null };
  };

  const isActive = (runId: string) => activeRun(runId) !== undefined;

  const listBuilds = (runs: Store): ListedBuild[] =>
    runs.listBuilds().map((build) => ({ ...build, old: isOld(build) }));

  const removeBuild = async (
    { runs }: EngineStores,
    buildId: string,
  ): Promise<DeleteBuildResult> => {
    if (active.has(buildId) || starting.has(buildId)) {
      return {
        ok: false,
        message: "A run of this build is in progress. Stop it before deleting the build.",
      };
    }
    deleting.add(buildId);
    try {
      return await deleteBuild(
        { store: runs, worktree: options.worktree, fs: options.fs, home: options.home },
        buildId,
      );
    } finally {
      deleting.delete(buildId);
    }
  };

  const leftWorktrees = async (): Promise<string[]> => {
    const folder = join(options.home, "worktrees");
    return (await options.fs.folders(folder)).map((name) => join(folder, name));
  };

  const workspaceInfo = async ({ repo, base }: BuildConfig) => {
    if (!repo) return null;
    const state = await options.gitState.read(repo);
    return {
      state,
      base: base ?? (isRepo(state) ? await options.gitState.defaultBranch(repo) : null),
    };
  };

  const listed = (summary: RunSummary): ListedRun =>
    summary.status === "running" && !isActive(summary.id)
      ? { ...summary, status: "interrupted" }
      : summary;

  const listRuns = (runs: Store): ListedRun[] => {
    const all = runs.listRuns().map(listed);
    const rest = all
      .filter((run) => !isActive(run.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return [...all.filter((run) => isActive(run.id)), ...rest];
  };

  const loadRun = ({ runs, flows }: EngineStores, runId: string): LoadedRun => {
    const record = runs.findRun(runId);
    const summary = runs.listRuns().find((candidate) => candidate.id === runId);
    if (record === undefined || summary === undefined) throw new Error(`No run ${runId}`);
    const run = listed(summary);
    const saved = run.source === undefined ? null : flows.load(run.source);
    return {
      ...(run.status === "interrupted" ? { note: notes.get(runId) ?? closedNote } : {}),
      run,
      name: saved?.name ?? null,
      flow: saved?.flow ?? null,
      snapshot: runSnapshot({
        runId,
        status: run.status,
        nodeIds: record.nodeIds,
        events: runs.events(runId),
      }),
      activity: runs.activity(runId),
    };
  };

  const doctor = async (needed: readonly string[]): Promise<DoctorReport> =>
    diagnoseConnectors(await options.connectors.list(), needed);

  const answer = async (id: number, work: () => unknown): Promise<EngineResponse> => {
    try {
      return { id, ok: true, value: (await work()) ?? null };
    } catch (error) {
      return { id, ok: false, error: messageOf(error) };
    }
  };

  const parsedAnswer = async <T>(
    request: EngineRequest,
    schema: z.ZodType<T>,
    work: (payload: T) => unknown,
  ): Promise<EngineResponse> => {
    const parsed = schema.safeParse(request.payload ?? {});
    if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
    return answer(request.id, () => work(parsed.data));
  };

  return {
    detach,
    reattach,
    async stop() {
      await startsSettled();
      await Promise.all([...active.values()].map(stopActive));
    },
    async handle(request) {
      switch (request.type) {
        case "version":
          return { id: request.id, ok: true, value: options.version };
        case "store-status":
          return { id: request.id, ok: true, value: storeStatus() };
        case "save-flow":
          return { id: request.id, ok: true, value: saveFlow(request.payload) };
        case "list-flows":
          return answer(request.id, () => storesOrThrow().flows.list());
        case "rename-flow":
          return parsedAnswer(request, renameFlowPayload, ({ flowId, name }) => {
            storesOrThrow().flows.rename(flowId, name);
          });
        case "open-flow":
          return parsedAnswer(request, openFlowPayload, ({ flowId }) =>
            openFlow(storesOrThrow(), flowId),
          );
        case "list-runs":
          return answer(request.id, () => listRuns(storesOrThrow().runs));
        case "load-run":
          return parsedAnswer(request, loadRunPayload, ({ runId }) =>
            loadRun(storesOrThrow(), runId),
          );
        case "doctor":
          return parsedAnswer(request, doctorPayload, ({ connectors }) => doctor(connectors));
        case "build-version": {
          const parsed = buildVersionPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const value = await withStores((stores) => buildFlowVersion(stores, parsed.data));
          return { id: request.id, ok: true, value };
        }
        case "list-builds":
          return answer(request.id, () => listBuilds(storesOrThrow().runs));
        case "build-files":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            buildFiles(storesOrThrow(), buildId),
          );
        case "delete-build":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            removeBuild(storesOrThrow(), buildId),
          );
        case "run-build": {
          const parsed = runBuildPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const { buildId, ...choices } = parsed.data;
          const value = await runBuild(buildId, choices);
          return { id: request.id, ok: true, value };
        }
        case "run-options":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            choicesOf(storesOrThrow(), buildId),
          );
        case "stop-run":
          return parsedAnswer(request, runIdPayload, ({ runId }) => stopRun(runId));
        case "retry-node":
          return parsedAnswer(request, retryPayload, ({ runId, nodeId }) =>
            continueRun(runId, { kind: "retry", nodeId }),
          );
        case "resume-run":
          return parsedAnswer(request, runIdPayload, ({ runId }) =>
            continueRun(runId, { kind: "resume" }),
          );
        case "run-cost":
          return parsedAnswer(request, runIdPayload, ({ runId }) =>
            runCost(storesOrThrow(), runId),
          );
        case "list-branches":
          return parsedAnswer(request, repoPayload, ({ repo }) => options.gitState.branches(repo));
        case "workspace-info":
          return parsedAnswer(request, workspaceInfoPayload, ({ buildConfig }) =>
            workspaceInfo(buildConfig),
          );
        case "doctor-worktrees":
          return answer(request.id, leftWorktrees);
        case "default-branch":
          return parsedAnswer(request, repoPayload, ({ repo }) =>
            options.gitState.defaultBranch(repo),
          );
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
