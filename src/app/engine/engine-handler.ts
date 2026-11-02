import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { writeSessionMcpConfig } from "../../adapters/claude/claude-connectors.js";
import type { BuildResult } from "../../core/compiler/build.js";
import { buildVersion } from "../../core/compiler/build-version.js";
import { resolveConnectors } from "../../core/compiler/connectors.js";
import { diagnoseConnectors, type DoctorReport } from "../../core/doctor/connectors.js";
import type { OpenedFlow } from "../../core/flow/flow-store.js";
import { parseFlow, type Flow } from "../../core/flow/schema.js";
import { workingFolderSchema, type FolderState } from "../../core/flow/workspace-info.js";
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
  runOptionsSchema,
  storedAuto,
  storedFlags,
  storedOptions,
  type RunChoices,
} from "../../core/run/options.js";
import { decideResume, type TranscriptTurn } from "../../core/run/resume.js";
import { resumeEntries, retryEntries } from "../../core/run/retry.js";
import type { EventEntry, StoredEvent } from "../../core/run/store.js";
import type {
  BuildFileContent,
  BuildVersionResult,
  ListedRun,
  LoadedRun,
} from "../../core/run/listing.js";
import { runSnapshot, type StartRunResult } from "../../core/run/snapshot.js";
import { waitAnswerSchema } from "../../core/run/wait.js";
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
  run: RunEnvironment & { now: () => number };
  newSessionName?: () => string;
  waits?: Pick<AppWaiter, "answer" | "drop">;
  worktree: Worktree;
  gitState: GitState;
  transcriptTurns: (claudeSessionId: string) => Promise<TranscriptTurn[]>;
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

const buildVersionPayload = z.object({ flowId: z.string(), version: z.number().int() });

const buildFilesPayload = z.object({ hash: z.string() });

const savePayload = z.object({
  flowId: z.string().nullable(),
  name: z.string().optional(),
  flow: z.unknown(),
});

const renameFlowPayload = z.object({ flowId: z.string(), name: z.string() });

const openFlowPayload = z.object({ flowId: z.string().optional() });

const loadRunPayload = z.object({ runId: z.string() });

const doctorPayload = z.object({ connectors: z.array(z.string()) });

const runBuildPayload = runOptionsSchema.extend({
  hash: z.string(),
  inputs: inputsSchema.optional(),
});

const runIdPayload = z.object({ runId: z.string() });

const retryPayload = z.object({ runId: z.string(), nodeId: z.string() });

const sessionGone =
  "This run's Claude session has ended, so it cannot go on from where it stopped.";

type Continuation = { kind: "retry"; nodeId: string } | { kind: "resume" };

export type { BuildFileContent, BuildVersionResult };

const saveTo = (
  flows: FlowStore,
  flowId: string | null,
  name: string | undefined,
  flow: Flow,
): SavedFlowRef => flows.save(flow, flowId ?? { name: name ?? "Untitled" });

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
      const { flowId, name, flow } = savePayload.parse(payload);
      const saved = saveTo(result.stores.flows, flowId, name, parseFlow(flow));
      return { kind: "saved", flowId: saved.flowId, version: saved.version };
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

  type Execution = {
    stores: EngineStores;
    runId: string;
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
    const { runs } = launch.stores;
    const { runId, manifest, nodeIds, claudeSessionId } = launch;
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
        open: launch.open,
        ...(launch.actions === undefined ? {} : { actions: launch.actions }),
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
    model: manifest.session.model,
    hooks: { nodePath: hooks.nodePath, hookScriptPath: hooks.hookScriptPath },
    ...(await writeSessionMcpConfig(options.fs, runMcpConfigPath(options.home, runId), servers)),
  });

  type RunBuildOptions = z.infer<typeof runOptionsSchema>;

  const runBuild = (hash: string, choices: RunBuildOptions): Promise<StartRunResult> =>
    oneAtATime(() => withStores((stores) => launchBuild(stores, hash, choices)));

  const launchBuild = async (
    stores: EngineStores,
    hash: string,
    choices: RunBuildOptions,
  ): Promise<StartRunResult> => {
    const { runs } = stores;
    const built = runs.findBuild(hash);
    if (built === undefined) return failure(`No build ${hash}`);
    const loaded = await loadBuild(built.dir, { fs: options.fs });
    if (loaded.kind === "error") return failure(loaded.message);
    const manifest = loaded.build;
    const clash = optionsClash(manifest);
    if (clash !== undefined) return failure(clash);
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
    const declared = runChoices(manifest).flags;
    const flags = Object.fromEntries(
      Object.entries(choices.flags ?? {}).filter(([name]) => name in declared),
    );
    const stored = storedOptions({
      inputs: choices.inputs ?? {},
      flags,
      auto: choices.auto ?? false,
    });
    const { id: runId } = runs.createRun({
      buildDir: built.dir,
      inputs: stored,
      nodeIds,
      session: { tmuxName: sessionName, cwd, claudeSessionId },
      buildHash: built.hash,
    });
    options.publish({
      push: "run-state",
      value: runSnapshot({ runId, status: "running", nodeIds, events: [] }),
    });
    const session = { sessionName, socketPath: socket.path, cwd, claudeSessionId };
    return startExecution({
      stores,
      runId,
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
              sessionName,
              options.publish,
            )
          : noClaude,
    });
  };

  const continueRun = (runId: string, how: Continuation): Promise<StartRunResult> =>
    oneAtATime(() => withStores((stores) => launchContinuation(stores, runId, how)));

  const launchContinuation = async (
    stores: EngineStores,
    runId: string,
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
    const loaded = await loadBuild(record.buildDir, { fs: options.fs });
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
    const decide = async (after: readonly StoredEvent[]) =>
      decideResume({
        manifest,
        events: after,
        turns: await options.transcriptTurns(claudeSessionId),
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
      const attach = events.some((event) => event.kind === "sent");
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
          }),
          sessionName,
          options.publish,
        );
      } catch (error) {
        return failure(error instanceof SessionGoneError ? sessionGone : messageOf(error));
      }
    }
    if (entries.length > 0) runs.appendAll(runId, entries);
    runs.reopenRun(runId);
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

  const stopActive = async (run: ActiveRun): Promise<void> => {
    if (run.interrupt === undefined) run.stopRequested = 143;
    else run.interrupt(143);
    await run.done;
  };

  const stopRun = async (runId: string): Promise<{ stopped: boolean }> => {
    await starting;
    const run = active;
    if (run?.runId !== runId) return { stopped: false };
    await stopActive(run);
    return { stopped: true };
  };

  const choicesOf = async ({ runs }: EngineStores, hash: string): Promise<RunChoices> => {
    const built = runs.findBuild(hash);
    if (built === undefined) throw new Error(`No build ${hash}`);
    const loaded = await loadBuild(built.dir, { fs: options.fs });
    if (loaded.kind === "error") throw new Error(loaded.message);
    const clash = optionsClash(loaded.build);
    if (clash !== undefined) throw new Error(clash);
    return runChoices(loaded.build);
  };

  const runCost = async ({ runs }: EngineStores, runId: string): Promise<CostReport> => {
    const record = runs.findRun(runId);
    if (record === undefined) throw new Error(`No run ${runId}`);
    const loaded = await loadBuild(record.buildDir, { fs: options.fs });
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

  const isActive = (runId: string) => runId === active?.runId;

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
    async stop() {
      await starting;
      const run = active;
      if (run !== undefined) await stopActive(run);
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
          const { hash, ...choices } = parsed.data;
          const value = await runBuild(hash, choices);
          return { id: request.id, ok: true, value };
        }
        case "run-options":
          return parsedAnswer(request, buildFilesPayload, ({ hash }) =>
            choicesOf(storesOrThrow(), hash),
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
