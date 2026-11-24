import { randomUUID } from "node:crypto";
import { join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { writeSessionMcpConfig } from "../../adapters/claude/claude-connectors.js";
import { workspaceDir, type BuildResult } from "../../core/compiler/build.js";
import { newBuildSessionName } from "../../core/compiler/build-session.js";
import {
  blueprintSessionFolder,
  blueprintSessionName,
  blueprintSessionSettings,
  blueprintSocketPath,
  githubMcpServer,
} from "../../core/compiler/blueprint-session.js";
import { buildAnswerSchema, type BuildAnswer } from "../../core/compiler/build-report.js";
import {
  buildInputsSchema,
  buildResumeOf,
  questionRule,
  resumeRequest,
  runBuild as runStagedBuild,
  startBuild,
  type BuildFlowDeps,
  type BuildOrigin,
  type BuildRequest,
  type BuildResume,
} from "../../core/compiler/build-version.js";
import { hookCommand, sessionEnvNames, shellQuote } from "../../core/compiler/hook-settings.js";
import type { ManifestContainer } from "../../core/compiler/lower.js";
import { plainProblems, type Problem } from "../../core/compiler/problems.js";
import { diagnoseConnectors, type DoctorReport } from "../../core/doctor/connectors.js";
import { latestLibraries, type LoadedFlow, type OpenedFlow } from "../../core/flow/flow-store.js";
import { expandLibraries, LibraryError } from "../../core/flow/libraries.js";
import { BuildConfig, parseFlow, type Flow } from "../../core/flow/schema.js";
import {
  progressOf,
  type BuildEvent,
  type BuildOutcome,
  type BuildSessionEvent,
  type PendingBuild,
  type StoredBuildEvent,
} from "../../core/run/build-progress.js";
import type { VariableValues } from "../../core/flow/variables.js";
import { costOf, type UsageReader } from "../../core/run/budget.js";
import {
  buildSessionGoneReason,
  defaultAlivePollMs,
  whenSessionGone,
} from "../../adapters/claude/claude-build-agents.js";
import { SessionGoneError } from "../../adapters/claude/claude-session.js";
import { chargeUsage, costReport, usageOwners, type CostReport } from "../../core/run/cost.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  parentsOf,
  runSocketPath,
  turnNodeIds,
  type LoadedBuild,
  type OpenedSession,
  type RunEnvironment,
  type StartedSessionsView,
} from "../../core/run/execute.js";
import { runChoices, storedAuto, storedOptions, type RunChoices } from "../../core/run/options.js";
import {
  deleteBuild,
  deletePreview,
  isInside,
  runWorktreeOf,
  storedBranch,
  teardownWorkspace,
  worktreePreview,
  type DeleteBuildResult,
} from "../../core/run/delete-build.js";
import { cutOffMessage, decideResume, type TranscriptTurn } from "../../core/run/resume.js";
import { carryOnNode, sessionContinuePrompt } from "../../core/run/session-continue.js";
import { turnFailure } from "../../core/run/turns.js";
import { retryEntries } from "../../core/run/retry.js";
import { sha256Hex } from "../../core/compiler/hash.js";
import { backfillManifests } from "../../core/run/backfill-manifests.js";
import { backfillSnapshots } from "../../core/run/backfill-snapshots.js";
import {
  parseManifest,
  sessionContainersOf,
  stageSourcesOf,
  workspaceOf,
  type ParsedManifest,
  type StageGroup,
} from "../../core/run/manifest.js";
import { nodeStatus } from "../../core/run/run-events.js";
import { pipelineOf, type PipelineGroup } from "../../core/run/pipeline.js";
import { runDigest, type RunDigest } from "../../core/run/digest.js";
import { sessionOverlayOf } from "../../core/run/finished-path.js";
import { candidatePaths } from "../../core/run/other-repos.js";
import { branchOf, type OtherRepo, type RepoState } from "../../core/run/repo-state.js";
import { settings as agentSettings } from "../../core/nodes/agent/settings.js";
import { settings as askSettings } from "../../core/nodes/ask/settings.js";
import { settings as gateSettings } from "../../core/nodes/gate/settings.js";
import type {
  BuildRecord,
  EventEntry,
  RunRecord,
  RunSession,
  RunStatus,
  StepText,
  StoredEvent,
} from "../../core/run/store.js";
import {
  buildEntriesSchema,
  buildProjectSchema,
  buildTreeSchema,
  pendingBuildTreeSchema,
  snapshotKeySchema,
  type BuildEntry,
  type BuildFileContent,
  type BuildProject,
  type BuildTree,
  type PendingBuildTree,
  type BuildVersionResult,
  type ListedRun,
  type LoadedRun,
  type WriteStoryResult,
} from "../../core/run/listing.js";
import { repoFolder, workspaceFolder } from "../../core/run/workspace.js";
import { runSnapshot, type RunSnapshot, type StartRunResult } from "../../core/run/snapshot.js";
import { waitAnswerSchema, type HumanWaiter } from "../../core/run/wait.js";
import type { BlueprintSessions } from "../../ports/blueprint-sessions.js";
import type { GithubTokenSource } from "../../ports/github-token.js";
import type {
  BuildAgents,
  BuildAgentsOpenSpec,
  BuildTurnResult,
} from "../../ports/build-agents.js";
import type { ConnectorSource } from "../../ports/connector-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import type { FlowStore, SaveFlowResult, SavedFlowRef } from "../../ports/flow-store.js";
import type { GitState } from "../../ports/git-state.js";
import type { PullRequests } from "../../ports/pull-requests.js";
import type { RunNarrator } from "../../ports/run-narrator.js";
import type { RunSummary, Store } from "../../ports/store.js";
import type { Worktree } from "../../ports/worktree.js";
import { createActivityTracker, createBuildActivity } from "./activity-tracker.js";
import type { AppWaiter } from "./app-waiter.js";
import type { HooksResult, PreparedHooks } from "./hooks.js";
import type {
  AssistantBuildState,
  AssistantListedBuild,
  AssistantReadBuild,
  BlueprintSessionStarted,
  BuildVersionStarted,
  EnginePush,
  EngineRequest,
  EngineResponse,
  StepFullText,
  StoreOpenResult,
} from "./protocol.js";
import { createPublishingStore } from "./publishing-store.js";
import { createRepoGate } from "./repo-gate.js";
import { StartedSessions } from "./started-sessions.js";

export type EngineStores = {
  runs: Store;
  flows: FlowStore;
  migrations?: { applied: readonly string[]; existedBefore: boolean };
};

const isCleanStart = (migration: string): boolean => migration.endsWith("clean_start");

const cleanStartFolders = ["workspaces", "runs", "build-sessions", "worktrees"];

const runFolder = (home: string, runId: string) => join(home, "runs", runId);

const sessionStatesPath = (home: string, runId: string) =>
  join(runFolder(home, runId), "session-states");

export type EngineHandlerOptions = {
  version: string;
  openStores: () => EngineStores;
  home: string;
  userHome?: string;
  publish: (push: EnginePush) => void;
  prepareHooks: () => PreparedHooks;
  buildAgents: BuildAgents;
  kit: () => Promise<{ dir: string; version: string }>;
  isFolder: (path: string) => boolean;
  fs: FileSystem;
  connectors: ConnectorSource;
  run: Omit<RunEnvironment, "waiter"> & { waiter?: HumanWaiter; now: () => number };
  newSessionName?: () => string;
  waits?: AppWaiter;
  worktree: Worktree;
  gitState: GitState;
  pullRequests: PullRequests;
  claudeConfig: { projectsDir: string; claudeJson: string };
  transcriptTurns: (claudeSessionId: string) => Promise<TranscriptTurn[]>;
  sessionAlive?: (sessionName: string) => Promise<boolean>;
  buildSessionPollMs?: number;
  endSession?: (sessionName: string) => Promise<void>;
  answerDialogs?: (tmuxName: string) => Promise<void>;
  homeLock?: { acquire(): Promise<boolean> };
  narrator?: RunNarrator;
  blueprint?:
    | {
        sessions: BlueprintSessions;
        kitDir: string;
        mcpScript: { nodePath: string; scriptPath: string };
        githubToken: GithubTokenSource;
      }
    | undefined;
};

export type EngineHandler = {
  handle(request: EngineRequest): Promise<EngineResponse>;
  stop(): Promise<void>;
  detach(): Promise<void>;
  reattach(): Promise<void>;
  sweepBlueprintSessions(): Promise<void>;
  startUp(): Promise<void>;
  shutDown(): Promise<void>;
};

type ActiveRun = {
  runId: string;
  buildId: string;
  done: Promise<void>;
  interrupt?: (code: number) => void;
  stopRequested?: number;
  detached?: boolean;
  untold?: boolean;
  stopEvents?: () => Promise<void>;
  claudeCalls: Set<Promise<unknown>>;
};

type Opened = { kind: "ready"; stores: EngineStores } | { kind: "error"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceInfoPayload = z.object({ buildConfig: BuildConfig });

const buildVersionPayload = buildInputsSchema.omit({ answers: true }).extend({
  flowId: z.string(),
  version: z.number().int(),
  name: z.string(),
});

const rebuildPayload = z.object({
  pendingId: z.string(),
  answers: z.array(buildAnswerSchema).min(1),
});

const keptInputs = z.object({ request: buildInputsSchema });

const buildIdPayload = z.object({ buildId: z.string() });

const buildEntriesPayload = z.object({ buildId: z.string(), path: z.string() });

const assistantReadBuildPayload = z.object({ id: z.string() });

const pendingIdPayload = z.object({ pendingId: z.string() });

const pendingRowPayload = z.object({ id: z.string() });

const repoPayload = z.object({ repo: z.string() });

const savePayload = z.object({
  flowId: z.string().nullable(),
  name: z.string().optional(),
  flow: z.unknown(),
});

const renameFlowPayload = z.object({ flowId: z.string(), name: z.string() });

const pinFlowPayload = z.object({ flowId: z.string(), pinned: z.boolean() });

const openFlowPayload = z.object({ flowId: z.string().optional() });

const expandFlowPayload = z.object({ flow: z.unknown() });

const loadRunPayload = z.object({ runId: z.string() });

const runBuildPayload = z.object({ buildId: z.string(), auto: z.boolean().optional() });

const runIdPayload = z.object({ runId: z.string() });

const stepFullTextPayload = z.object({ runId: z.string(), entryId: z.number().int() });

const buildStepFullTextPayload = z.object({ pendingId: z.string(), entryId: z.number().int() });

const retryPayload = z.object({ runId: z.string(), nodeId: z.string() });

const flowIdPayload = z.object({ flowId: z.string() });

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
    runSessions: (runId) => store.runSessions(runId),
    nodeSessions: (runId) => store.nodeSessions(runId),
    listRuns: () => store.listRuns(),
    findRunSummary: (id) => store.findRunSummary(id),
    events: (id) => store.events(id),
    activity: (id) => store.activity(id),
    findBuild: (id) => store.findBuild(id),
    findBuildByName: (name) => store.findBuildByName(name),
    listBuilds: () => store.listBuilds(),
    buildWorktrees: (buildId) => store.buildWorktrees(buildId),
    buildFiles: (id) => store.buildFiles(id),
    startPendingBuild: (build) => store.startPendingBuild(build),
    appendBuildEvent: (pendingId, event) => store.appendBuildEvent(pendingId, event),
    buildEvents: (pendingId) => store.buildEvents(pendingId),
    endPendingBuild: (pendingId, end) => store.endPendingBuild(pendingId, end),
    listPendingBuilds: () => store.listPendingBuilds(),
    listLatestEndedPendingBuildsByName: () => store.listLatestEndedPendingBuildsByName(),
    findPendingBuildByName: (name) => store.findPendingBuildByName(name),
    pendingBuild: (id) => store.pendingBuild(id),
    appendBuildActivity: (pendingId, entry) => store.appendBuildActivity(pendingId, entry),
    buildActivity: (pendingId) => store.buildActivity(pendingId),
    buildSnapshot: (key) => store.buildSnapshot(key),
    listSnapshotGaps: () => store.listSnapshotGaps(),
    addSnapshotIfMissing: (gap, snapshot) => store.addSnapshotIfMissing(gap, snapshot),
    buildManifest: (buildId) => store.buildManifest(buildId),
    listManifestGaps: () => store.listManifestGaps(),
    recordBuild: (build) => store.recordBuild(build),
    addBuildWorktree: (buildId, worktree) => store.addBuildWorktree(buildId, worktree),
    deleteBuild: (id) => store.deleteBuild(id),
    deleteRun: (runId) => store.deleteRun(runId),
    deletePendingBuild: (id) => store.deletePendingBuild(id),
    storeManifest(manifest) {
      if (!detached()) store.storeManifest(manifest);
    },
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
    appendRunStory: (story) => store.appendRunStory(story),
    latestRunStory: (runId) => store.latestRunStory(runId),
    appendRepoState: (id, phase, state, otherRepos) =>
      store.appendRepoState(id, phase, state, otherRepos),
    repoStates: (id) => store.repoStates(id),
    appendStepText(id, entryId, field, text) {
      if (!detached()) store.appendStepText(id, entryId, field, text);
    },
    stepTexts: (id, entryId) => store.stepTexts(id, entryId),
    appendOtherRepoBefore(id, repo, state) {
      if (!detached()) store.appendOtherRepoBefore(id, repo, state);
    },
    appendBuildStepText: (pendingId, entryId, field, text) =>
      store.appendBuildStepText(pendingId, entryId, field, text),
    buildStepTexts: (pendingId, entryId) => store.buildStepTexts(pendingId, entryId),
  };
}

type Continuation = { kind: "retry"; nodeId: string } | { kind: "resume" };

export type BuiltVersion = BuildVersionStarted | Extract<BuildVersionResult, { kind: "error" }>;

type BuildProgressEntry = Omit<Extract<EnginePush, { push: "build-progress" }>, "push">;

export type ListedBuild = BuildRecord & { old: boolean };

export type { BuildFileContent };

const saveTo = (
  flows: FlowStore,
  flowId: string | null,
  name: string | undefined,
  flow: Flow,
): SavedFlowRef => flows.save(flow, flowId ?? { name: name ?? "Untitled" });

const fullTextOf = (kept: readonly StepText[]): StepFullText =>
  kept.length === 0
    ? { kept: false }
    : { kept: true, texts: Object.fromEntries(kept.map(({ field, text }) => [field, text])) };

const problemText = ({ node, text }: Problem) => (node === undefined ? text : `${node}: ${text}`);

const refusedBuild = (result: Extract<BuildResult, { ok: false }>): BuiltVersion => {
  const problems = plainProblems(result.errors);
  return { kind: "error", message: problems.map(problemText).join("\n"), problems };
};

const keptAnswersOf = (pending: PendingBuild): { answers?: BuildAnswer[] } => {
  const answers = keptInputs.safeParse(pending.origin).data?.request.answers;
  return answers === undefined ? {} : { answers };
};

const progressEntry = (
  pending: PendingBuild,
  runs: Store,
  buildId?: string,
): BuildProgressEntry => {
  const events = runs.buildEvents(pending.id);
  const snapshot = runs.buildSnapshot({ pendingId: pending.id });
  return {
    pendingId: pending.id,
    name: pending.name,
    flowId: pending.flowId,
    startedAt: pending.startedAt,
    ...(pending.endedAt === undefined ? {} : { endedAt: pending.endedAt }),
    ...(pending.outcome === undefined ? {} : { outcome: pending.outcome }),
    ...(snapshot === null
      ? {}
      : { blueprintName: snapshot.blueprintName, blueprintVersion: snapshot.version }),
    events,
    progress: progressOf(pending, events),
    ...(buildId === undefined ? {} : { buildId }),
  };
};

const isOld = (build: BuildRecord) => build.name === null;

type ProjectBuild = BuildRecord & { name: string; repo: string; base: string };

type ContainerSession = { container: ManifestContainer; session: RunSession };

const containerSessions = (
  manifest: Pick<ParsedManifest, "containers">,
  sessions: readonly RunSession[],
): ContainerSession[] =>
  sessionContainersOf(manifest).flatMap((container) => {
    const session = sessions.find((row) => row.cwd === container.worktree);
    return session === undefined ? [] : [{ container, session }];
  });

const sessionEnv = (
  manifest: Pick<ParsedManifest, "containers">,
  sessions: readonly RunSession[],
): Record<string, string> => {
  const names = sessionEnvNames(manifest.containers);
  return Object.fromEntries(
    containerSessions(manifest, sessions).flatMap(({ container, session }) => {
      const name = names.get(container.slug);
      return name === undefined
        ? []
        : [
            [name.tmux, session.tmuxName],
            [name.id, session.claudeSessionId],
          ];
    }),
  );
};

const startedIn = (
  manifest: Pick<ParsedManifest, "containers">,
  sessions: readonly RunSession[],
  events: readonly StoredEvent[],
): ContainerSession[] => {
  const touched = new Set(events.map((event) => event.nodeId));
  return containerSessions(manifest, sessions).filter(({ container }) =>
    container.nodes.some((node) => touched.has(node.id)),
  );
};

const reachedStop = (container: ManifestContainer, events: readonly StoredEvent[]): boolean =>
  container.nodes.some((node) => {
    const status = nodeStatus(events.filter((event) => event.nodeId === node.id));
    return status === "failed" || (node.type === "output" && status === "done");
  });

const allNodes = (manifest: Pick<ParsedManifest, "containers">) =>
  manifest.containers.flatMap((container) => container.nodes);

const ownFolders = (manifest: Pick<ParsedManifest, "containers">): string[] =>
  sessionContainersOf(manifest).flatMap((container) =>
    container.worktree === undefined ? [] : [container.worktree],
  );

const sessionGroupsOf = (manifest: Pick<ParsedManifest, "containers">) =>
  stageSourcesOf(manifest).slice(1);

const flatStages = (groups: readonly StageGroup[]) => ({
  session: { name: groups[0]?.name ?? "" },
  nodes: groups.flatMap((group) => group.nodes),
  wires: groups.flatMap((group) => group.wires),
});

const hasProject = (build: BuildRecord): build is ProjectBuild =>
  build.name !== null && build.repo !== null && build.base !== null;

const assistantBuildState = (build: BuildRecord): AssistantBuildState =>
  isOld(build) ? "old" : "live";

const assistantListedBuild = (build: BuildRecord): AssistantListedBuild => ({
  id: build.id,
  name: build.name,
  blueprint: build.source?.flowId ?? null,
  version: build.source?.version ?? null,
  state: assistantBuildState(build),
});

const isRepo = (state: { kind: string }) => state.kind === "branch" || state.kind === "detached";

function announced(
  opened: OpenedSession,
  runId: string,
  sessionName: string,
  publish: (push: EnginePush) => void,
  running: boolean,
  onShown: () => void,
): OpenedSession {
  let isAnnounced = running;
  const show = () => {
    publish({ push: "session", runId, value: sessionName });
    onShown();
  };
  if (running) show();
  return {
    ...opened,
    session: {
      async ensureStarted() {
        await opened.session.ensureStarted();
        if (isAnnounced) return;
        isAnnounced = true;
        show();
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
      return opened;
    }
    try {
      const { failures } = backfillSnapshots({
        store: opened.stores.runs,
        flows: opened.stores.flows,
      });
      for (const { gap, error } of failures) {
        const which =
          gap.buildId === null ? `pending build ${gap.pendingId}` : `build ${gap.buildId}`;
        console.log(`engine: snapshot backfill skipped ${which} error ${messageOf(error)}`);
      }
    } catch (error) {
      console.log(`engine: snapshot backfill error ${messageOf(error)}`);
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

  const buildStops = new Map<string, () => Promise<void>>();

  const buildSessionFolder = (sessionName: string) =>
    join(options.home, "build-sessions", sessionName);

  const buildDeps = async (
    stores: EngineStores,
    hooks: Extract<PreparedHooks, { kind: "ok" }>,
    sessionName: string,
  ): Promise<BuildFlowDeps> => ({
    store: stores.runs,
    flows: stores.flows,
    fs: options.fs,
    home: options.home,
    gitState: options.gitState,
    worktree: options.worktree,
    newId: randomUUID,
    now: options.run.now,
    agents: options.buildAgents,
    kit: await options.kit(),
    sessionName: () => sessionName,
    newSessionId: randomUUID,
    settingsPath: join(buildSessionFolder(sessionName), "settings.json"),
    guardCommand: [hooks.nodePath, hooks.guardScriptPath].map(shellQuote).join(" "),
    hookCommand: hookCommand(hooks),
  });

  const finishBuild = (
    runs: Store,
    pending: PendingBuild,
    outcome: BuildOutcome,
    built?: string,
  ) => {
    buildStops.delete(pending.id);
    const endedAt = runs.pendingBuild(pending.id)?.endedAt;
    options.publish({
      push: "build-progress",
      ...progressEntry(
        { ...pending, ...(endedAt === undefined ? {} : { endedAt }), outcome },
        runs,
        built,
      ),
    });
  };

  const turnStopped = async (
    { sessionName, claudeSessionId }: BuildAgentsOpenSpec,
    turnsSent: number,
  ) => {
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") throw new Error(socket.message);
    const started = await options.run.startEvents(socket.path);
    try {
      await new Promise<void>((resolve, reject) => {
        const watch = whenSessionGone(
          () => options.buildAgents.alive(sessionName),
          options.buildSessionPollMs ?? defaultAlivePollMs,
        );
        const unsubscribe = () => {
          unsubscribeStop();
          unsubscribeFailure();
          watch.cancel();
        };
        void watch.gone.then(() => {
          unsubscribe();
          reject(new Error(buildSessionGoneReason));
        });
        const unsubscribeStop = started.events.subscribe("Stop", claudeSessionId, () => {
          unsubscribe();
          resolve();
        });
        const unsubscribeFailure = started.events.subscribe(
          "StopFailure",
          claudeSessionId,
          (event) => {
            unsubscribe();
            reject(turnFailure(event));
          },
        );
        void options.transcriptTurns(claudeSessionId).then(
          (turns) => {
            if (turns.length !== turnsSent || turns.at(-1)?.ended !== true) return;
            unsubscribe();
            resolve();
          },
          () => undefined,
        );
      });
    } finally {
      await started.stop();
    }
  };

  type PendingBuildRun = {
    stores: EngineStores;
    pending: PendingBuild;
    flow: Flow;
    request: BuildRequest;
    origin: BuildOrigin;
    deps: BuildFlowDeps;
    resume?: BuildResume;
  };

  const runPendingBuild = ({
    stores: { runs },
    pending,
    flow,
    request,
    origin,
    deps,
    resume,
  }: PendingBuildRun) => {
    const stopping = new AbortController();
    const stopped = () => stopping.signal.aborted;
    let recorded: string | undefined;
    let opened: { sessionName: string; claudeSessionId: string } | undefined;
    let report: unknown;
    const store: BuildFlowDeps["store"] = {
      recordBuild: (build) => {
        recorded = build.id;
        deps.store.recordBuild(build);
      },
      findBuildByName: (name) => deps.store.findBuildByName(name),
      startPendingBuild: (build) => deps.store.startPendingBuild(build),
      appendBuildEvent: (pendingId, event) => deps.store.appendBuildEvent(pendingId, event),
      findPendingBuildByName: (name) => deps.store.findPendingBuildByName(name),
      addBuildWorktree: (buildId, worktree) => deps.store.addBuildWorktree(buildId, worktree),
      endPendingBuild: (pendingId, end) => {
        report = end.report;
        deps.store.endPendingBuild(pendingId, end);
      },
    };
    const finish = (outcome: BuildOutcome, built?: string) =>
      finishBuild(runs, report === undefined ? pending : { ...pending, report }, outcome, built);
    const publishProgress = () =>
      options.publish({ push: "build-progress", ...progressEntry(pending, runs) });
    const onEvent = (pendingId: string, event: BuildEvent) => {
      if (event.type === "session") {
        options.publish({ push: "session", runId: pendingId, value: event.name });
      }
      publishProgress();
    };
    const recordCost = async (claudeSessionId: string) => {
      const entries = await options.run.usage?.entries(claudeSessionId);
      if (entries === undefined || stopped()) return;
      runs.appendBuildEvent(pending.id, {
        type: "cost",
        inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
        outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
        usd: costOf(entries),
      });
      publishProgress();
    };
    const recordCall = createBuildActivity({
      pendingId: pending.id,
      now: options.run.now,
      activity: runs,
      publish: options.publish,
    });
    const agents: BuildFlowDeps["agents"] = {
      async open(spec) {
        opened = spec;
        await options.buildAgents.open(spec);
        if (spec.attach === true) await turnStopped(spec, resume?.turnsSent ?? 0);
      },
      async turn(name, text, onCall): Promise<BuildTurnResult> {
        const result = await options.buildAgents.turn(
          name,
          text,
          (call, report) => {
            if (stopped()) return;
            recordCall(call, report);
            onCall(call);
          },
          (event) => {
            if (!stopped()) recordCall.step(event);
          },
        );
        if (opened !== undefined) await recordCost(opened.claudeSessionId);
        return result;
      },
      close: (name) => options.buildAgents.close(name),
    };
    const started = { kind: "started" as const, pendingId: pending.id };
    const ended = runStagedBuild(
      started,
      flow,
      request,
      { ...deps, store, agents, onEvent, signal: stopping.signal },
      origin,
      resume,
    ).then(
      (result) => {
        if (result.ok) return finish("built", result.record.id);
        if (stopped()) return finish("stopped");
        const asked = result.errors.some((error) => error.rule === questionRule);
        return finish(asked ? "needs-you" : "failed");
      },
      (error: unknown) => {
        console.log(`engine: build ${pending.id} error ${messageOf(error)}`);
        if (recorded !== undefined) return finish("built", recorded);
        if (stopped()) {
          finish("stopped");
          throw error;
        }
        if (runs.listPendingBuilds().some((open) => open.id === pending.id)) {
          runs.endPendingBuild(pending.id, { outcome: "failed", endedAt: options.run.now() });
        }
        finish("failed");
      },
    );
    ended.catch((error: unknown) => {
      console.log(`engine: build ${pending.id} finish error ${messageOf(error)}`);
    });
    buildStops.set(pending.id, async () => {
      if (recorded !== undefined) return;
      stopping.abort();
      await ended;
    });
  };

  const startFromSaved = async (
    stores: EngineStores,
    saved: Omit<LoadedFlow, "flowId">,
    { flowId, version, buildModel, ...request }: z.infer<typeof buildVersionPayload>,
    answers?: readonly BuildAnswer[],
    frozen?: Flow,
  ): Promise<BuiltVersion> => {
    const buildRequest = {
      name: request.name,
      values: request.values as VariableValues,
      ...(request.repo === undefined ? {} : { repo: request.repo }),
      ...(request.base === undefined ? {} : { base: request.base }),
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      ...(buildModel === undefined ? {} : { buildModel }),
      ...(answers === undefined ? {} : { answers }),
    };
    const origin = {
      source: { flowId, version },
      blueprint: { name: saved.name, version: saved.version },
      request: {
        values: request.values,
        ...(request.repo === undefined ? {} : { repo: request.repo }),
        ...(request.base === undefined ? {} : { base: request.base }),
        ...(request.branch === undefined ? {} : { branch: request.branch }),
        ...(buildModel === undefined ? {} : { buildModel }),
        ...(answers === undefined ? {} : { answers: [...answers] }),
      },
    };
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") {
      return refusedBuild({ ok: false, errors: [{ rule: "hooks", message: hooks.message }] });
    }
    const deps = await buildDeps(stores, hooks, newBuildSessionName(randomUUID));
    const started = await startBuild(saved.flow, buildRequest, deps, origin, frozen);
    if ("errors" in started) return refusedBuild(started);
    const pending = stores.runs.listPendingBuilds().find((open) => open.id === started.pendingId);
    if (pending === undefined) throw new Error(`No pending build ${started.pendingId}`);
    runPendingBuild({
      stores,
      pending,
      flow: started.flow,
      request: buildRequest,
      origin,
      deps,
    });
    return { kind: "started", pendingId: started.pendingId };
  };

  const buildFlowVersion = async (
    stores: EngineStores,
    payload: z.infer<typeof buildVersionPayload>,
  ): Promise<BuiltVersion> => {
    const { flowId, version } = payload;
    const saved = stores.flows.load({ flowId, version });
    if (saved === null) {
      return refusedBuild({
        ok: false,
        errors: [{ rule: "version", message: `${flowId} has no saved version ${version}` }],
      });
    }
    return startFromSaved(stores, saved, payload);
  };

  const rebuildBuild = async (
    stores: EngineStores,
    pendingId: string,
    answers: readonly BuildAnswer[],
  ): Promise<BuiltVersion> => {
    const asked = stores.runs.pendingBuild(pendingId);
    if (asked === null) throw new Error(`No build ${pendingId}`);
    if (asked.endedAt === undefined) throw new Error(`Build ${asked.name} is still going`);
    if (asked.outcome !== "needs-you")
      throw new Error(`Build ${asked.name} did not end needing answers`);
    const kept = keptInputs.safeParse(asked.origin);
    if (!kept.success) {
      throw new Error(`Build ${asked.name} did not keep its inputs; build the blueprint again`);
    }
    const snapshot = stores.runs.buildSnapshot({ pendingId });
    if (snapshot === null) {
      throw new Error(
        `Build ${asked.name} has no snapshot of its blueprint; build the blueprint again`,
      );
    }
    const saved = stores.flows.load({ flowId: asked.flowId, version: asked.version });
    if (saved === null) {
      throw new Error(`${asked.flowId} has no saved version ${asked.version}`);
    }
    const { answers: answeredBefore = [], ...inputs } = kept.data.request;
    return startFromSaved(
      stores,
      { name: snapshot.blueprintName, version: snapshot.version, flow: saved.flow },
      { flowId: asked.flowId, version: asked.version, name: asked.name, ...inputs },
      [...answeredBefore, ...answers],
      snapshot.flow,
    );
  };

  const lastSession = (runs: Store, pendingId: string) =>
    runs
      .buildEvents(pendingId)
      .findLast((event): event is BuildSessionEvent & StoredBuildEvent => event.type === "session");

  const sessionWorkspace = async (runs: Store, session: BuildSessionEvent) => {
    const worktrees = [];
    for (const row of runs.buildWorktrees(session.buildId)) {
      if (await options.fs.exists(row.path)) worktrees.push(runWorktreeOf(row));
    }
    return { dir: workspaceDir(options.home, session.buildId), worktrees };
  };

  const failLeftBuild = async (runs: Store, pending: PendingBuild, why: string) => {
    console.log(`engine: build ${pending.id} not reattached (${why})`);
    const session = lastSession(runs, pending.id);
    if (session !== undefined) {
      if (await options.buildAgents.alive(session.name))
        await options.buildAgents.close(session.name);
      await options.fs.removeTree(buildSessionFolder(session.name));
      await teardownWorkspace(
        { fs: options.fs, worktree: options.worktree },
        await sessionWorkspace(runs, session),
      );
    }
    runs.endPendingBuild(pending.id, { outcome: "failed", endedAt: options.run.now() });
    finishBuild(runs, pending, "failed");
  };

  const reattachBuild = async (stores: EngineStores, pending: PendingBuild): Promise<void> => {
    const { runs } = stores;
    const resume = buildResumeOf(runs.buildEvents(pending.id));
    if (resume === undefined) return failLeftBuild(runs, pending, "not mid turn");
    const { session } = resume;
    if (!(await options.buildAgents.alive(session.name))) {
      return failLeftBuild(runs, pending, "its session has ended");
    }
    const snapshot = runs.buildSnapshot({ pendingId: pending.id });
    if (snapshot === null)
      return failLeftBuild(runs, pending, "it has no snapshot of its blueprint");
    let saved: LoadedFlow | null;
    try {
      saved = stores.flows.load({ flowId: pending.flowId, version: pending.version });
    } catch (error) {
      return failLeftBuild(runs, pending, `its blueprint cannot be read: ${messageOf(error)}`);
    }
    if (saved === null) {
      return failLeftBuild(runs, pending, `its blueprint has no version ${pending.version}`);
    }
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failLeftBuild(runs, pending, hooks.message);
    options.publish({ push: "session", runId: pending.id, value: session.name });
    runPendingBuild({
      stores,
      pending,
      flow: snapshot.flow ?? saved.flow,
      request: {
        ...resumeRequest(pending.name, session),
        ...keptAnswersOf(pending),
      },
      origin: {
        source: { flowId: pending.flowId, version: pending.version },
        blueprint: { name: snapshot.blueprintName, version: snapshot.version },
      },
      deps: await buildDeps(stores, hooks, session.name),
      resume,
    });
    console.log(`engine: build ${pending.id} reattached`);
  };

  const stopBuild = async (pendingId: string) => {
    const stop = buildStops.get(pendingId);
    if (stop === undefined) throw new Error(`No build ${pendingId} is going`);
    await stop();
  };

  const buildProgressList = (runs: Store): BuildProgressEntry[] => [
    ...runs.listPendingBuilds().map((pending) => progressEntry(pending, runs)),
    ...runs
      .listLatestEndedPendingBuildsByName()
      .map((ended) => progressEntry(ended, runs, ended.buildId)),
  ];

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
    sessionName: string;
    claudeSessionId: string;
    stored: Record<string, unknown>;
    open: (
      failNode: (claudeSessionId: string, nodeId: string, message: string) => void,
    ) => Promise<OpenedSession>;
    attached?: boolean;
    actions?: () => Promise<ReturnType<typeof decideResume>>;
  };

  const statesWriter = (runId: string) => {
    const path = sessionStatesPath(options.home, runId);
    let written = Promise.resolve();
    return (text: string) => {
      written = written
        .then(() => options.fs.writeFile(path, text))
        .catch((error: unknown) => {
          console.log(`engine: run ${runId} session states not written: ${messageOf(error)}`);
        });
    };
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
    let eventsFailed = false;
    const continuesEarlierRun = launch.actions !== undefined;
    const sessionRows = runs.runSessions(runId).filter((row) => row.parent !== null);
    const alreadyStarted = startedIn(manifest, sessionRows, runs.events(runId)).map(
      ({ session }) => session.claudeSessionId,
    );
    let supervisor: StartedSessions | undefined;
    let workspaceShown = false;
    const pushSessions = () => {
      const started = new Set(supervisor?.started() ?? alreadyStarted);
      options.publish({
        push: "run-sessions",
        runId,
        sessions: [
          ...(workspaceShown
            ? [{ container: workspaceOf(manifest).name, tmuxName: launch.sessionName }]
            : []),
          ...containerSessions(manifest, sessionRows)
            .filter(({ session }) => started.has(session.claudeSessionId))
            .map(({ container, session }) => ({
              container: container.name,
              tmuxName: session.tmuxName,
            })),
        ],
      });
    };
    const startedSessions: StartedSessionsView = {
      finish: async () => {
        if (!isDetached()) await supervisor?.finish();
      },
      started: () => supervisor?.started() ?? [],
      failure: () => supervisor?.failure(),
    };
    const tracker = createActivityTracker({
      runId,
      now: options.run.now,
      publish: options.publish,
      log: (line) => console.log(`engine: activity ${line}`),
      activity: runs,
      turnNodes: turnNodeIds({ nodes: allNodes(manifest) }),
      sessionNodes: new Map(
        containerSessions(manifest, sessionRows).map(({ container, session }) => [
          session.claudeSessionId,
          new Set(container.nodes.map((node) => node.id)),
        ]),
      ),
      place:
        options.userHome === undefined
          ? { cwd: launch.cwd }
          : { cwd: launch.cwd, home: options.userHome },
    });
    const store = createPublishingStore({
      store: tracker.store(runs),
      runId,
      nodeIds,
      sessionGroups: sessionGroupsOf(manifest),
      publish: options.publish,
    });
    run.done = execute(
      {
        ...options.run,
        waiter: waiterFor(runId),
        store,
        startEvents: async (path) => {
          const started = await options.run.startEvents(path).catch((error: unknown) => {
            eventsFailed = true;
            throw error;
          });
          const sessionIds = [claudeSessionId, ...sessionRows.map((row) => row.claudeSessionId)];
          const repoGate = repoGateOf(runs, runId, manifest);
          const ungates = sessionIds.map((id) =>
            started.toolStarts?.onToolStart(id, repoGate.check),
          );
          supervisor = new StartedSessions({
            runId,
            events: started.events,
            ...(started.permissions === undefined ? {} : { permissions: started.permissions }),
            fs: options.fs,
            store,
            waiter: waiterFor(runId),
            sessionAlive,
            endSession: options.endSession ?? (async () => undefined),
            ...(options.answerDialogs === undefined
              ? {}
              : { answerDialogs: options.answerDialogs }),
            writeStates: sessionRows.length === 0 ? () => undefined : statesWriter(runId),
            manifest,
            sessions: sessionRows,
            history: runs.events(runId),
            onStart: pushSessions,
          });
          const unwatches = sessionIds.map((id) => tracker.watch(started.events, id));
          const stopEvents = async () => {
            for (const unwatch of unwatches) unwatch();
            repoGate.close();
            for (const ungate of ungates) ungate?.();
            supervisor?.halt();
            await started.stop();
          };
          run.stopEvents = stopEvents;
          return { ...started, stop: stopEvents };
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
        cwd: launch.cwd,
        auto: storedAuto(launch.stored),
        socketPath: launch.socketPath,
        startedSessions,
        open: async () => {
          const raw = await launch.open((claudeSessionId, nodeId, message) =>
            supervisor?.failNode(claudeSessionId, nodeId, message),
          );
          const opened =
            raw === noClaude
              ? raw
              : announced(
                  raw,
                  runId,
                  launch.sessionName,
                  options.publish,
                  launch.attached === true,
                  () => {
                    workspaceShown = true;
                    pushSessions();
                  },
                );
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
      .finally(async () => {
        if (isDetached()) return;
        options.waits?.drop(runId);
        if (active.get(run.buildId) === run) active.delete(run.buildId);
        try {
          console.log(`engine: run ${runId} ${runs.findRun(runId)?.status ?? "unknown"}`);
        } catch (error) {
          console.log(`engine: run ${runId} unknown (${messageOf(error)})`);
        }
        await recordAfter(launch.stores.runs, runId);
        if (run.untold !== true) void narrate(launch.stores.runs, runId);
      });
    active.set(run.buildId, run);
    console.log(`engine: run ${runId} started`);
    return { kind: "started", runId };
  };

  const sessionOptions = (
    manifest: LoadedBuild,
    buildDir: string,
    session: { sessionName: string; socketPath: string; cwd: string; claudeSessionId: string },
    hooks: Extract<HooksResult, { kind: "ok" }>,
    model = workspaceOf(manifest).model,
  ) => ({
    ...session,
    buildDir,
    workspaceFolder: workspaceFolder(buildDir),
    layout: manifest.layout,
    model,
    hooks: { nodePath: hooks.nodePath, hookScriptPath: hooks.hookScriptPath },
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
    const { cwd } = manifest;
    if (!options.isFolder(cwd)) return failure(`Working folder not found: ${cwd}`);
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failure(hooks.message);
    const sessionName = newSessionName();
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") return failure(socket.message);
    const claudeSessionId = randomUUID();
    const workspace = workspaceOf(manifest);
    const sessions = sessionContainersOf(manifest).flatMap((container) =>
      container.worktree === undefined
        ? []
        : [
            {
              tmuxName: newSessionName(),
              cwd: container.worktree,
              claudeSessionId: randomUUID(),
              nodeIds: container.nodes.map((node) => node.id),
            },
          ],
    );
    const nodeIds = [workspace, ...sessionContainersOf(manifest)].flatMap((container) =>
      container.nodes.map((node) => node.id),
    );
    const stored = storedOptions({ inputs: {}, flags: {}, auto: choices.auto ?? false });
    const { id: runId } = runs.createRun({
      buildDir: built.dir,
      inputs: stored,
      nodeIds,
      session: { tmuxName: sessionName, cwd, claudeSessionId },
      sessions,
      buildId,
    });
    options.publish({
      push: "run-state",
      value: runSnapshot({ runId, status: "running", nodeIds, events: [] }),
    });
    const session = { sessionName, socketPath: socket.path, cwd, claudeSessionId };
    const recordedBefore = recordBefore(runs, runId, ownFolders(manifest)[0] ?? cwd);
    return startExecution({
      stores,
      runId,
      buildId,
      manifest,
      nodeIds,
      cwd,
      socketPath: socket.path,
      sessionName,
      claudeSessionId,
      stored,
      open: async () => {
        await recordedBefore;
        return needsClaude(workspace)
          ? options.run.openSession({
              ...sessionOptions(manifest, built.dir, session, hooks),
              env: sessionEnv(manifest, sessions),
              ...(sessions.length === 0
                ? {}
                : { sessionStatesPath: sessionStatesPath(options.home, runId) }),
            })
          : noClaude;
      },
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
    const summary = runs.findRunSummary(runId);
    if (record === undefined || summary === undefined) return failure(`No run ${runId}`);
    const status = listed(summary).status;
    if (how.kind === "resume" && status !== "stopped" && status !== "interrupted") {
      return failure("Only a stopped or interrupted run can be resumed");
    }
    const loaded = await loadBuild(buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") return failure(loaded.message);
    const manifest = loaded.build;
    const workspace = workspaceOf(manifest);
    const events = runs.events(runId);
    let entries: EventEntry[];
    try {
      entries = how.kind === "retry" ? retryEntries(workspace, events, how.nodeId) : [];
    } catch (error) {
      return failure(messageOf(error));
    }
    const { tmuxName: sessionName, cwd, claudeSessionId } = record.session;
    const sentBefore = needsClaude(workspace) && events.some((event) => event.kind === "sent");
    const restart = sentBefore && !(await sessionAlive(sessionName));
    const decide = async (after: readonly StoredEvent[]) =>
      decideResume({
        manifest: { ...workspace, hash: manifest.hash },
        events: after,
        turns: await options.transcriptTurns(claudeSessionId),
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
    const sessions = runs.runSessions(runId).filter((row) => row.parent !== null);
    const reopening: ContainerSession[] = [];
    for (const started of startedIn(manifest, sessions, events)) {
      if (reachedStop(started.container, events)) continue;
      if (await sessionAlive(started.session.tmuxName)) continue;
      const cutOff = started.container.nodes.filter(
        (node) =>
          node.type === "agent" &&
          ["running", "needs-you"].includes(
            nodeStatus(events.filter((event) => event.nodeId === node.id)),
          ),
      );
      if (cutOff.length === 0) {
        reopening.push(started);
        continue;
      }
      for (const node of cutOff) {
        entries.push({
          nodeId: node.id,
          event: { kind: "failed", payload: { message: cutOffMessage(node.id) } },
        });
      }
    }
    const hooks = options.prepareHooks();
    if (hooks.kind === "error") return failure(hooks.message);
    const socket = runSocketPath(options.home, sessionName);
    if (socket.kind === "error") return failure(socket.message);
    let opened: OpenedSession = noClaude;
    const attach = sentBefore && !restart;
    if (needsClaude(workspace)) {
      try {
        opened = await options.run.openSession({
          ...sessionOptions(
            manifest,
            record.buildDir,
            { sessionName, socketPath: socket.path, cwd, claudeSessionId },
            hooks,
          ),
          env: sessionEnv(manifest, sessions),
          ...(sessions.length === 0
            ? {}
            : { sessionStatesPath: sessionStatesPath(options.home, runId) }),
          ...(attach ? { attach: true } : {}),
          ...(restart ? { resume: true } : {}),
        });
      } catch (error) {
        return failure(error instanceof SessionGoneError ? sessionGone : messageOf(error));
      }
    }
    const reopen = async (
      failNode: (claudeSessionId: string, nodeId: string, message: string) => void,
    ) => {
      for (const { container, session } of reopening) {
        try {
          const resumed = await options.run.openSession({
            ...sessionOptions(
              manifest,
              record.buildDir,
              {
                sessionName: session.tmuxName,
                socketPath: socket.path,
                cwd: session.cwd,
                claudeSessionId: session.claudeSessionId,
              },
              hooks,
              container.model,
            ),
            resume: true,
          });
          await resumed.session.ensureStarted();
          await resumed.prompts.sendPrompt(sessionContinuePrompt(container, events));
        } catch (error) {
          const carryOn = carryOnNode(container, events);
          if (carryOn !== undefined)
            failNode(session.claudeSessionId, carryOn.id, messageOf(error));
        }
      }
    };
    if (entries.length > 0) runs.appendAll(runId, entries);
    runs.reopenRun(runId);
    notes.delete(runId);
    options.publish({
      push: "run-state",
      value: runSnapshot(
        {
          runId,
          status: "running",
          nodeIds: record.nodeIds,
          events: runs.events(runId),
        },
        sessionGroupsOf(manifest),
      ),
    });
    return startExecution({
      stores,
      runId,
      buildId,
      manifest,
      nodeIds: record.nodeIds,
      cwd,
      socketPath: socket.path,
      sessionName,
      claudeSessionId,
      stored: record.inputs,
      open: async (failNode) => {
        await reopen(failNode);
        return opened;
      },
      attached: attach,
      actions: () => decide(runs.events(runId)),
    });
  };

  const holdsHome = async () => options.homeLock === undefined || options.homeLock.acquire();

  const sweepAfterCleanStart = async (): Promise<void> => {
    const result = openStoresOnce();
    if (result.kind === "error") return;
    const { migrations } = result.stores;
    if (migrations?.existedBefore !== true) return;
    if (!migrations.applied.some(isCleanStart)) return;
    if (!(await holdsHome())) return;
    await Promise.all(
      cleanStartFolders.map((folder) => options.fs.removeTree(join(options.home, folder))),
    );
  };

  const backfillStoredManifests = async (): Promise<void> => {
    const result = openStoresOnce();
    if (result.kind === "error") return;
    const { runs } = result.stores;
    const failures = await backfillManifests({
      store: runs,
      readManifest: async (buildId) => {
        const build = runs.findBuild(buildId);
        return build === undefined ? undefined : options.fs.readFile(`${build.dir}/manifest.json`);
      },
      sha256: sha256Hex,
    });
    for (const { gap, error } of failures) {
      console.log(
        `engine: manifest backfill skipped build ${gap.buildId} error ${messageOf(error)}`,
      );
    }
  };

  const reattach = async (): Promise<void> => {
    if (!(await holdsHome())) {
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
    for (const pending of runs.listPendingBuilds()) {
      try {
        await reattachBuild(result.stores, pending);
      } catch (error) {
        console.log(`engine: build ${pending.id} not reattached (${messageOf(error)})`);
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
    const workspace = workspaceOf(loaded.build);
    if (needsClaude(workspace) && sent && !(await sessionAlive(record.session.tmuxName))) {
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
    closeNarrations();
    await startsSettled();
    await Promise.all(
      [...active.values()].map(async (run) => {
        run.detached = true;
        await claudeCallsSettled(run);
        await run.stopEvents?.();
      }),
    );
  };

  const readRepoState = (folder: string): Promise<RepoState> =>
    options.gitState.repoState(folder).catch(() => ({ kind: "unreadable" }) as const);

  const recordBefore = async (runs: Store, runId: string, cwd: string): Promise<void> => {
    try {
      runs.appendRepoState(runId, "before", await readRepoState(cwd), []);
    } catch (error) {
      console.log(`engine: run ${runId} before state not recorded (${messageOf(error)})`);
    }
  };

  const repoGateOf = (runs: Store, runId: string, manifest: LoadedBuild) => {
    const repo = runs.findRun(runId)?.repo ?? null;
    return createRepoGate({
      own: [...ownFolders(manifest), ...(repo === null ? [] : [repo])],
      sessions: runs.runSessions(runId),
      seen: runs
        .repoStates(runId)
        .otherRepos.filter((other) => other.before !== undefined)
        .map((other) => other.path),
      ...(options.userHome === undefined ? {} : { home: options.userHome }),
      gitState: options.gitState,
      readState: readRepoState,
      record: (path, state) => {
        runs.appendOtherRepoBefore(runId, path, state);
      },
      log: (line) => console.log(`engine: run ${runId} ${line}`),
    });
  };

  const otherReposOf = async (runs: Store, record: RunRecord): Promise<OtherRepo[]> => {
    const { gitState, userHome } = options;
    const manifest = manifestOf(record);
    const own = [
      record.session.cwd,
      ...(manifest === undefined ? [] : ownFolders(manifest)),
      ...(record.repo === null ? [] : [record.repo]),
    ];
    const skipped = new Set(own);
    for (const path of own) skipped.add((await gitState.topLevel(path)) ?? path);
    const befores = new Map(
      runs
        .repoStates(record.id)
        .otherRepos.flatMap((other) =>
          other.before === undefined ? [] : [[other.path, other.before] as const],
        ),
    );
    const tops = new Set(befores.keys());
    for (const path of candidatePaths(
      runs.activity(record.id),
      userHome === undefined ? {} : { home: userHome },
    )) {
      const top = await gitState.topLevel(path);
      if (top !== null && !skipped.has(top)) tops.add(top);
    }
    const repos: OtherRepo[] = [];
    for (const path of [...tops].sort()) {
      const after = await readRepoState(path);
      const before = befores.get(path);
      const branch =
        branchOf(after) ??
        (before === undefined ? undefined : (branchOf(before) ?? "not recorded"));
      if (branch !== undefined) repos.push({ path, branch, after });
    }
    return repos;
  };

  const recordAfter = async (runs: Store, runId: string): Promise<void> => {
    try {
      const record = runs.findRun(runId);
      if (record === undefined) return;
      const manifest = manifestOf(record);
      const folder = (manifest === undefined ? [] : ownFolders(manifest))[0] ?? record.session.cwd;
      const state = await readRepoState(folder);
      const otherRepos = await otherReposOf(runs, record).catch((error: unknown) => {
        console.log(`engine: run ${runId} other repos not read (${messageOf(error)})`);
        return [];
      });
      runs.appendRepoState(runId, "after", state, otherRepos);
    } catch (error) {
      console.log(`engine: run ${runId} after state not recorded (${messageOf(error)})`);
    }
  };

  const stopActive = async (run: ActiveRun): Promise<void> => {
    if (run.interrupt === undefined) run.stopRequested = 143;
    else run.interrupt(143);
    await run.done;
  };

  const halt = async (
    runId: string,
    { tell }: { tell: boolean },
  ): Promise<{ stopped: boolean }> => {
    await startsSettled();
    const run = activeRun(runId);
    if (run !== undefined) {
      if (!tell) run.untold = true;
      await stopActive(run);
      return { stopped: true };
    }
    const { runs } = storesOrThrow();
    const record = runs.findRun(runId);
    if (record?.status !== "running") return { stopped: false };
    runs.stopRun(runId);
    await recordAfter(runs, runId);
    if (tell) void narrate(runs, runId);
    const children = runs
      .runSessions(runId)
      .filter((row) => row.parent !== null)
      .map(({ tmuxName }) => tmuxName);
    for (const tmuxName of [record.session.tmuxName, ...children]) {
      if (tmuxName.startsWith("fd-") && (await sessionAlive(tmuxName))) {
        await options.endSession?.(tmuxName);
      }
    }
    return { stopped: true };
  };

  const stopRun = (runId: string) => halt(runId, { tell: true });

  const stopForDelete = async (runId: string): Promise<void> => {
    await halt(runId, { tell: false });
  };

  const removeRun = async (runId: string): Promise<void> => {
    await stopForDelete(runId);
    storesOrThrow().runs.deleteRun(runId);
    await options.fs.removeTree(runFolder(options.home, runId));
  };

  const choicesOf = async ({ runs }: EngineStores, buildId: string): Promise<RunChoices> => {
    const loaded = await loadBuild(buildId, { fs: options.fs, store: runs });
    if (loaded.kind === "error") return { kind: "error", message: loaded.message };
    return runChoices(workspaceOf(loaded.build));
  };

  const manifestOf = (run: RunRecord): ParsedManifest | undefined =>
    run.manifestJson === null || run.buildHash === null
      ? undefined
      : parseManifest(run.manifestJson, { hash: run.buildHash, name: run.buildName });

  type StoredNode = ManifestContainer["nodes"][number];

  const questionOf = (node: StoredNode): string | undefined => {
    if (node.type === "gate") return gateSettings.safeParse(node.settings).data?.shown;
    if (node.type === "ask") return askSettings.safeParse(node.settings).data?.question;
    return undefined;
  };

  const instructionsOf = (node: StoredNode): string | undefined =>
    node.type === "agent"
      ? agentSettings.pick({ instructions: true }).safeParse(node.settings).data?.instructions
      : undefined;

  const digestStagesOf = (manifest: ParsedManifest) => {
    const stages = flatStages(stageSourcesOf(manifest));
    const instructions = new Map(
      allNodes(manifest).flatMap((node) => {
        const text = instructionsOf(node);
        return text === undefined ? [] : [[node.id, text] as const];
      }),
    );
    return {
      ...stages,
      nodes: stages.nodes.map((stage) => {
        const text = instructions.get(stage.id);
        return text === undefined ? stage : { ...stage, instructions: text };
      }),
    };
  };

  const questionsOf = (manifest: ParsedManifest): Record<string, string> =>
    Object.fromEntries(
      allNodes(manifest).flatMap((node) => {
        const question = questionOf(node);
        return question === undefined ? [] : [[node.id, question]];
      }),
    );

  const digestOf = (runs: Store, runId: string): RunDigest | undefined => {
    const record = runs.findRun(runId);
    const summary = runs.findRunSummary(runId);
    if (record === undefined || summary === undefined) throw new Error(`No run ${runId}`);
    if (record.buildHash === null) return undefined;
    const manifest = manifestOf(record);
    const events = runs.events(runId);
    const last = events.at(-1);
    const now = isActive(runId) || last === undefined ? options.run.now() : Date.parse(last.time);
    return runDigest(
      {
        build: {
          name: record.buildName,
          hash: record.buildHash,
          blueprintName: record.blueprintName,
          blueprintVersion: record.source?.version ?? null,
          repo: record.repo,
          branch: record.branch,
          values: record.buildValues,
        },
        stages: manifest === undefined ? null : digestStagesOf(manifest),
        events,
        activity: runs.activity(runId),
        cost: costReport({ nodeIds: record.nodeIds, events, pending: [], now }),
        createdAt: summary.createdAt,
        endedAt: summary.endedAt,
        status: record.status,
        questions: manifest === undefined ? {} : questionsOf(manifest),
        repoStates: runs.repoStates(runId),
      },
      manifest === undefined ? undefined : sessionOverlayOf(sessionGroupsOf(manifest), events),
    );
  };

  const narrations = new Set<AbortController>();
  let narrationsClosed = false;

  const closeNarrations = () => {
    narrationsClosed = true;
    for (const narration of narrations) narration.abort(new Error("Flowdeck is closing"));
  };

  const narrating = new Map<string, number>();

  const tell = async (
    runs: Store,
    runId: string,
    narrator: RunNarrator,
    runStatus: Exclude<RunStatus, "running">,
  ): Promise<void> => {
    const controller = new AbortController();
    narrations.add(controller);
    narrating.set(runId, (narrating.get(runId) ?? 0) + 1);
    try {
      const digest = digestOf(runs, runId);
      if (digest === undefined) throw new Error("its build is not stored");
      const seen = runs.events(runId).length;
      const told = await narrator.narrate(digest.text, controller.signal);
      if (runs.findRun(runId)?.status !== runStatus || runs.events(runId).length !== seen) {
        throw new Error("the run has moved on since it ended");
      }
      runs.appendRunStory({
        runId,
        at: new Date(options.run.now()).toISOString(),
        runStatus,
        text: told.text,
        cost: told.cost,
      });
      options.publish({ push: "story", runId });
    } finally {
      narrations.delete(controller);
      const left = (narrating.get(runId) ?? 1) - 1;
      if (left === 0) narrating.delete(runId);
      else narrating.set(runId, left);
    }
  };

  const narrate = async (runs: Store, runId: string): Promise<void> => {
    const { narrator } = options;
    if (narrator === undefined || narrationsClosed) return;
    try {
      const runStatus = runs.findRun(runId)?.status;
      if (runStatus === undefined || runStatus === "running") return;
      await tell(runs, runId, narrator, runStatus);
    } catch (error) {
      console.log(`engine: run ${runId} story not written (${messageOf(error)})`);
    }
  };

  const writeStory = async (runs: Store, runId: string): Promise<WriteStoryResult> => {
    const refused = (error: string): WriteStoryResult => ({ ok: false, error });
    const { narrator } = options;
    const runStatus = runs.findRun(runId)?.status;
    if (narrator === undefined || narrationsClosed) return refused("Stories cannot be written now");
    if (runStatus === undefined) return refused(`No run ${runId}`);
    if (runStatus === "running") return refused("The run has not ended");
    if (narrating.has(runId)) return refused("The run's story is being written");
    if (runs.latestRunStory(runId) !== undefined) return refused("The run already has a story");
    try {
      await tell(runs, runId, narrator, runStatus);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  };

  const pendingUsage = async (
    runs: Store,
    run: RunRecord,
    events: StoredEvent[],
    usage: UsageReader,
  ) => {
    const manifest = manifestOf(run);
    if (manifest === undefined) throw new Error("manifest.json: missing");
    const sessions = runs.runSessions(run.id).filter((row) => row.parent !== null);
    const charged = [
      { container: workspaceOf(manifest), session: run.session },
      ...startedIn(manifest, sessions, events),
    ];
    const charges = await Promise.all(
      charged.map(async ({ container, session }) =>
        chargeUsage({
          events,
          entries: await usage.entries(session.claudeSessionId),
          turnNodes: turnNodeIds(container),
          owners: usageOwners(container, events),
          parents: parentsOf(container),
        }),
      ),
    );
    return charges.flat();
  };

  const runCost = async ({ runs }: EngineStores, runId: string): Promise<CostReport> => {
    const record = runs.findRun(runId);
    if (record?.buildId === undefined) throw new Error(`No run ${runId}`);
    const events = runs.events(runId);
    const live = isActive(runId);
    const usage = options.run.usage;
    const pending =
      live && usage !== undefined ? await pendingUsage(runs, record, events, usage) : [];
    const last = events.at(-1);
    const now = live || last === undefined ? options.run.now() : Date.parse(last.time);
    return costReport({ nodeIds: record.nodeIds, events, pending, now });
  };

  const runPipeline = async (
    stores: EngineStores,
    runId: string,
  ): Promise<PipelineGroup[] | null> => {
    const { runs } = stores;
    const record = runs.findRun(runId);
    const summary = runs.findRunSummary(runId);
    if (record === undefined || summary === undefined) throw new Error(`No run ${runId}`);
    const manifest = manifestOf(record);
    if (manifest === undefined) return null;
    return pipelineOf(
      stageSourcesOf(manifest),
      runs.events(runId),
      [],
      await runCost(stores, runId),
      listed(summary).status,
    );
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
    if (found === undefined) {
      if (flows.isDeleted(flowId)) throw new Error(`Blueprint ${flowId} was deleted`);
      throw new Error(`No blueprint ${flowId}`);
    }
    return { flowId, name: found.name, version: null, flow: null };
  };

  const expandFlow = ({ flows }: EngineStores, flow: Flow) => {
    try {
      return expandLibraries(flow, latestLibraries(flows));
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      return { problem: error.message };
    }
  };

  const isActive = (runId: string) => activeRun(runId) !== undefined;

  const listBuilds = (runs: Store): ListedBuild[] =>
    runs.listBuilds().map((build) => ({ ...build, old: isOld(build) }));

  const readWorktree = async (
    runs: Store,
    build: BuildRecord,
  ): Promise<AssistantReadBuild["worktree"]> => {
    const [row] = hasProject(build) ? runs.buildWorktrees(build.id) : [];
    if (row === undefined) return null;
    const { path, repo, branch, base } = row;
    if (!(await options.fs.exists(path)))
      return { path, exists: false, dirty: null, unpushed: null };
    return {
      path,
      exists: true,
      dirty: await options.worktree.isDirty(path),
      unpushed: await options.worktree.hasUnpushed(repo, branch, base),
    };
  };

  const buildTree = (runs: Store, buildId: string): BuildTree => {
    const build = runs.findBuild(buildId);
    if (build === undefined) throw new Error(`No build ${buildId}`);
    return buildTreeSchema.parse({ paths: runs.buildFiles(buildId).map(({ path }) => path) });
  };

  const buildProject = async (runs: Store, buildId: string): Promise<BuildProject | null> => {
    const build = runs.findBuild(buildId);
    if (build === undefined) throw new Error(`No build ${buildId}`);
    if (!hasProject(build)) return null;
    const worktree = await readWorktree(runs, build);
    if (worktree === null) return null;
    const { branch, create } = storedBranch(build, build.name);
    return buildProjectSchema.parse({
      repoFolder: repoFolder(build.repo),
      branch,
      branchCreated: create,
      base: build.base,
      ...worktree,
    });
  };

  const buildEntries = async (
    runs: Store,
    { buildId, path }: { buildId: string; path: string },
  ): Promise<BuildEntry[]> => {
    const build = runs.findBuild(buildId);
    if (build === undefined) throw new Error(`No build ${buildId}`);
    if (!hasProject(build)) throw new Error(`Build ${buildId} has no project`);
    const target = join(build.dir, path);
    const underCheckout = runs
      .buildWorktrees(build.id)
      .some((row) => target === normalize(row.path) || isInside(row.path, target));
    if (!isInside(build.dir, target) || !underCheckout)
      throw new Error(`${path} is outside the build's project`);
    return buildEntriesSchema.parse(await options.fs.entries(target, { inside: build.dir }));
  };

  const pendingBuildTree = async (
    runs: Store,
    pendingId: string,
  ): Promise<PendingBuildTree | null> => {
    const laidDown = runs
      .buildEvents(pendingId)
      .flatMap((event) => (event.type === "worktree" ? [normalize(event.path)] : []));
    const latest = laidDown.at(-1);
    if (latest === undefined) return null;
    const workspaces = normalize(join(options.home, "workspaces"));
    const [buildId = ".."] = relative(workspaces, latest).split(sep);
    if (buildId === ".." || buildId === "") return null;
    const dir = workspaceDir(options.home, buildId);
    const checkouts = laidDown.filter((path) => isInside(dir, path));
    if (!(await options.fs.exists(dir))) return null;
    return pendingBuildTreeSchema.parse({
      paths: await options.fs.list(dir, { skip: checkouts }),
    });
  };

  const readBuild = async (runs: Store, id: string): Promise<AssistantReadBuild> => {
    const build = runs.findBuild(id);
    if (build === undefined) throw new Error(`No build ${id}`);
    const exists = await options.fs.exists(build.dir);
    const worktree = await readWorktree(runs, build);
    const checkouts = runs.buildWorktrees(build.id).map((row) => row.path);
    return {
      repo: build.repo,
      base: build.base,
      values: build.values,
      workspace: {
        path: build.dir,
        exists,
        tree: exists
          ? await options.fs.list(build.dir, checkouts.length === 0 ? {} : { skip: checkouts })
          : [],
      },
      worktree,
    };
  };

  const sessionFolderOf = (runs: Store, buildId: string): { sessionFolder?: string } => {
    const pendingId = runs.buildSnapshot({ buildId })?.pendingId;
    if (pendingId == null) return {};
    const session = runs
      .buildEvents(pendingId)
      .findLast((event): event is BuildSessionEvent & StoredBuildEvent => event.type === "session");
    return session === undefined ? {} : { sessionFolder: buildSessionFolder(session.name) };
  };

  const removeBuild = async (
    { runs }: EngineStores,
    buildId: string,
  ): Promise<DeleteBuildResult> => {
    deleting.add(buildId);
    try {
      await startsSettled();
      return await deleteBuild(
        {
          store: runs,
          worktree: options.worktree,
          fs: options.fs,
          home: options.home,
          pullRequests: options.pullRequests,
          claudeConfig: options.claudeConfig,
          ...sessionFolderOf(runs, buildId),
        },
        buildId,
      );
    } finally {
      deleting.delete(buildId);
    }
  };

  const previewDelete = async (runs: Store, buildId: string) => {
    const build = runs.findBuild(buildId);
    if (build === undefined) throw new Error(`No build ${buildId}`);
    return deletePreview({ worktree: options.worktree, fs: options.fs, store: runs }, build);
  };

  const previewPendingDelete = async (runs: Store, id: string) => {
    const pending = runs.pendingBuild(id);
    if (pending === null) throw new Error(`No pending build ${id}`);
    const session = lastSession(runs, id);
    const left = session === undefined ? undefined : await sessionWorkspace(runs, session);
    return worktreePreview({ worktree: options.worktree, fs: options.fs }, left?.worktrees ?? []);
  };

  const removePendingBuild = async (runs: Store, id: string): Promise<void> => {
    if (buildStops.has(id)) await stopBuild(id);
    const pending = runs.pendingBuild(id);
    const session = lastSession(runs, id);
    if (pending !== null && session !== undefined) {
      await options.fs.removeTree(buildSessionFolder(session.name));
      const left = await sessionWorkspace(runs, session);
      if (await options.fs.exists(left.dir))
        await teardownWorkspace(
          { fs: options.fs, worktree: options.worktree },
          { ...left, force: true },
        );
    }
    runs.deletePendingBuild(id);
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

  const doneIn = (snapshot: RunSnapshot) =>
    Object.values(snapshot.nodes).filter((state) => state === "done").length;

  const runShapes = new Map<string, { nodeIds: readonly string[]; groups: StageGroup[] }>();
  const shapeOf = (runs: Store, runId: string) => {
    const known = runShapes.get(runId);
    if (known !== undefined) return known;
    const record = runs.findRun(runId);
    const manifest = record === undefined ? undefined : manifestOf(record);
    const shape = {
      nodeIds: record?.nodeIds ?? [],
      groups: manifest === undefined ? [] : sessionGroupsOf(manifest),
    };
    runShapes.set(runId, shape);
    return shape;
  };

  const doneCounts = new Map<string, { key: string; count: number }>();
  const withDoneCount = (runs: Store, run: ListedRun): ListedRun => {
    if (isActive(run.id)) return run;
    const { nodeIds, groups } = shapeOf(runs, run.id);
    if (groups.length === 0) return run;
    const key = `${run.status}|${run.endedAt}`;
    const cached = doneCounts.get(run.id);
    if (cached?.key === key) return { ...run, doneCount: cached.count };
    const count = doneIn(
      runSnapshot(
        { runId: run.id, status: run.status, nodeIds, events: runs.events(run.id) },
        groups,
      ),
    );
    doneCounts.set(run.id, { key, count });
    return { ...run, doneCount: count };
  };

  const listRuns = (runs: Store): ListedRun[] => {
    const all = runs.listRuns().map((summary) => withDoneCount(runs, listed(summary)));
    const rest = all
      .filter((run) => !isActive(run.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return [...all.filter((run) => isActive(run.id)), ...rest];
  };

  const loadRun = ({ runs }: EngineStores, runId: string): LoadedRun => {
    const record = runs.findRun(runId);
    const summary = runs.findRunSummary(runId);
    if (record === undefined || summary === undefined) throw new Error(`No run ${runId}`);
    const listedRun = listed(summary);
    const manifest = manifestOf(record);
    const groups = manifest === undefined ? [] : sessionGroupsOf(manifest);
    const snapshot = runSnapshot(
      {
        runId,
        status: listedRun.status,
        nodeIds: record.nodeIds,
        events: runs.events(runId),
      },
      groups,
    );
    const run = groups.length === 0 ? listedRun : { ...listedRun, doneCount: doneIn(snapshot) };
    const digest = digestOf(runs, runId);
    const written = runs.latestRunStory(runId);
    return {
      ...(run.status === "interrupted" ? { note: notes.get(runId) ?? closedNote } : {}),
      ...(digest === undefined
        ? {}
        : {
            story: {
              header: digest.header,
              digest: digest.text,
              written:
                written === undefined
                  ? null
                  : {
                      text: written.text,
                      at: written.at,
                      runStatus: written.runStatus,
                      cost: written.cost,
                    },
            },
          }),
      run,
      name: run.buildName,
      stages: manifest === undefined ? null : flatStages(stageSourcesOf(manifest).slice(0, 1)),
      snapshot,
      activity: runs.activity(runId),
    };
  };

  const stepFullText = ({ runs }: EngineStores, runId: string, entryId: number): StepFullText => {
    if (runs.findRunSummary(runId) === undefined) throw new Error(`No run ${runId}`);
    return fullTextOf(runs.stepTexts(runId, entryId));
  };

  const buildStepFullText = (
    { runs }: EngineStores,
    pendingId: string,
    entryId: number,
  ): StepFullText => {
    if (runs.pendingBuild(pendingId) === null) throw new Error(`No pending build ${pendingId}`);
    return fullTextOf(runs.buildStepTexts(pendingId, entryId));
  };

  const blueprintOrThrow = () => {
    if (options.blueprint === undefined) throw new Error("Blueprint sessions are not available");
    return options.blueprint;
  };

  const startBlueprintSession = async (flowId: string): Promise<BlueprintSessionStarted> => {
    const { sessions, kitDir, mcpScript, githubToken } = blueprintOrThrow();
    const session = blueprintSessionName(flowId);
    if (!(await sessions.alive(session))) {
      const hooks = options.prepareHooks();
      if (hooks.kind === "error") throw new Error(hooks.message);
      const folder = blueprintSessionFolder(options.home, flowId);
      const socketPath = blueprintSocketPath(options.home);
      const settingsPath = join(folder, "settings.json");
      const mcpConfigPath = join(folder, "mcp.json");
      const settings = blueprintSessionSettings({
        home: options.home,
        hookCommand: hookCommand(hooks),
        webGuardCommand: [hooks.nodePath, hooks.webGuardScriptPath].map(shellQuote).join(" "),
      });
      await options.fs.writeFile(settingsPath, JSON.stringify(settings));
      const token = await githubToken.token();
      await writeSessionMcpConfig(options.fs, mcpConfigPath, {
        flowdeck: {
          command: mcpScript.nodePath,
          args: [mcpScript.scriptPath],
          env: { FLOWDECK_BP_SOCK: socketPath, FLOWDECK_BP_SESSION: session },
        },
        ...(token === undefined ? {} : { github: githubMcpServer(token) }),
      });
      await sessions.start({
        session,
        cwd: folder,
        settingsPath,
        mcpConfigPath,
        kitDir,
        socketPath,
      });
    }
    options.publish({ push: "session", runId: session, value: session });
    return { session };
  };

  const stopBlueprintSession = async (sessions: BlueprintSessions, flowId: string) => {
    await sessions.stop(blueprintSessionName(flowId));
    await options.fs.removeTree(blueprintSessionFolder(options.home, flowId));
  };

  const stopAllBlueprintSessions = async (sessions: BlueprintSessions) => {
    if (!(await holdsHome())) return;
    const flowIds = await options.fs.folders(join(options.home, "bp-sessions"));
    await Promise.all(flowIds.map((flowId) => stopBlueprintSession(sessions, flowId)));
  };

  const sweepBlueprintSessions = async () => {
    if (options.blueprint !== undefined) await stopAllBlueprintSessions(options.blueprint.sessions);
  };

  const doctor = async (): Promise<DoctorReport> =>
    diagnoseConnectors(await options.connectors.list());

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

  const shutDown = async (): Promise<void> => {
    await detach().catch((error: unknown) => {
      console.log(`engine: detach error ${messageOf(error)}`);
    });
    await sweepBlueprintSessions();
  };

  return {
    detach,
    reattach,
    sweepBlueprintSessions,
    shutDown,
    async startUp() {
      await sweepBlueprintSessions().catch((error: unknown) => {
        console.log(`engine: blueprint sweep error ${messageOf(error)}`);
      });
      await sweepAfterCleanStart().catch((error: unknown) => {
        console.log(`engine: clean start sweep error ${messageOf(error)}`);
      });
      await backfillStoredManifests().catch((error: unknown) => {
        console.log(`engine: manifest backfill error ${messageOf(error)}`);
      });
      await reattach();
    },
    async stop() {
      closeNarrations();
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
        case "pin-flow":
          return parsedAnswer(request, pinFlowPayload, ({ flowId, pinned }) => {
            storesOrThrow().flows.pin(flowId, pinned);
          });
        case "delete-flow":
          return parsedAnswer(request, flowIdPayload, async ({ flowId }) => {
            const stores = storesOrThrow();
            const building = stores.runs
              .listPendingBuilds()
              .some((pending) => pending.flowId === flowId && pending.endedAt === undefined);
            if (building)
              throw new Error("This blueprint is being built. Wait for the build to end first.");
            const users = stores.flows.usedBy(flowId);
            if (users.length > 0)
              throw new Error(
                `This library is used by ${users.map(({ name }) => name).join(", ")}. Remove it from those blueprints before deleting it.`,
              );
            stores.flows.delete(flowId);
            if (options.blueprint !== undefined) {
              await stopBlueprintSession(options.blueprint.sessions, flowId);
            }
          });
        case "open-flow":
          return parsedAnswer(request, openFlowPayload, ({ flowId }) =>
            openFlow(storesOrThrow(), flowId),
          );
        case "expand-flow":
          return parsedAnswer(request, expandFlowPayload, ({ flow }) =>
            expandFlow(storesOrThrow(), parseFlow(flow)),
          );
        case "list-runs":
          return answer(request.id, () => listRuns(storesOrThrow().runs));
        case "load-run":
          return parsedAnswer(request, loadRunPayload, ({ runId }) =>
            loadRun(storesOrThrow(), runId),
          );
        case "step-full-text":
          return parsedAnswer(request, stepFullTextPayload, ({ runId, entryId }) =>
            stepFullText(storesOrThrow(), runId, entryId),
          );
        case "build-step-full-text":
          return parsedAnswer(request, buildStepFullTextPayload, ({ pendingId, entryId }) =>
            buildStepFullText(storesOrThrow(), pendingId, entryId),
          );
        case "doctor":
          return answer(request.id, doctor);
        case "build-version": {
          const parsed = buildVersionPayload.safeParse(request.payload);
          if (!parsed.success) return { id: request.id, ok: false, error: parsed.error.message };
          const value = await withStores((stores) => buildFlowVersion(stores, parsed.data));
          return { id: request.id, ok: true, value };
        }
        case "build-rebuild":
          return parsedAnswer(request, rebuildPayload, ({ pendingId, answers }) =>
            rebuildBuild(storesOrThrow(), pendingId, answers),
          );
        case "build-stop":
          return parsedAnswer(request, pendingIdPayload, ({ pendingId }) => stopBuild(pendingId));
        case "build-activity":
          return parsedAnswer(request, pendingIdPayload, ({ pendingId }) =>
            storesOrThrow().runs.buildActivity(pendingId),
          );
        case "build-progress-list":
          return answer(request.id, () => buildProgressList(storesOrThrow().runs));
        case "list-builds":
          return answer(request.id, () => listBuilds(storesOrThrow().runs));
        case "assistant-list-builds":
          return answer(request.id, () =>
            storesOrThrow().runs.listBuilds().map(assistantListedBuild),
          );
        case "assistant-read-build":
          return parsedAnswer(request, assistantReadBuildPayload, ({ id }) =>
            readBuild(storesOrThrow().runs, id),
          );
        case "build-files":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            buildFiles(storesOrThrow(), buildId),
          );
        case "build-tree":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            buildTree(storesOrThrow().runs, buildId),
          );
        case "build-project":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            buildProject(storesOrThrow().runs, buildId),
          );
        case "build-entries":
          return parsedAnswer(request, buildEntriesPayload, (payload) =>
            buildEntries(storesOrThrow().runs, payload),
          );
        case "pending-build-tree":
          return parsedAnswer(request, pendingIdPayload, ({ pendingId }) =>
            pendingBuildTree(storesOrThrow().runs, pendingId),
          );
        case "build-picture":
          return parsedAnswer(request, snapshotKeySchema, (key) => ({
            svg: storesOrThrow().runs.buildSnapshot(key)?.svg ?? null,
          }));
        case "delete-build":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            removeBuild(storesOrThrow(), buildId),
          );
        case "delete-run":
          return parsedAnswer(request, runIdPayload, ({ runId }) => removeRun(runId));
        case "delete-pending-build":
          return parsedAnswer(request, pendingRowPayload, ({ id }) =>
            removePendingBuild(storesOrThrow().runs, id),
          );
        case "delete-preview":
          return parsedAnswer(request, buildIdPayload, ({ buildId }) =>
            previewDelete(storesOrThrow().runs, buildId),
          );
        case "delete-pending-preview":
          return parsedAnswer(request, pendingRowPayload, ({ id }) =>
            previewPendingDelete(storesOrThrow().runs, id),
          );
        case "write-story":
          return parsedAnswer(request, runIdPayload, ({ runId }) =>
            writeStory(storesOrThrow().runs, runId),
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
        case "run-pipeline":
          return parsedAnswer(request, runIdPayload, ({ runId }) =>
            runPipeline(storesOrThrow(), runId),
          );
        case "list-branches":
          return parsedAnswer(request, repoPayload, ({ repo }) => options.gitState.branches(repo));
        case "checked-out-branches":
          return parsedAnswer(request, repoPayload, ({ repo }) =>
            options.gitState.checkedOutBranches(repo),
          );
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
        case "blueprint-session-start":
          return parsedAnswer(request, flowIdPayload, ({ flowId }) =>
            startBlueprintSession(flowId),
          );
        case "blueprint-session-stop":
          return parsedAnswer(request, flowIdPayload, ({ flowId }) =>
            stopBlueprintSession(blueprintOrThrow().sessions, flowId),
          );
        case "blueprint-session-stop-all":
          return answer(request.id, () => stopAllBlueprintSessions(blueprintOrThrow().sessions));
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
