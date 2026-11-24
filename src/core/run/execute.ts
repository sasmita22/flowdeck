import type { HookPaths } from "../compiler/hook-settings.js";
import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";
import { verify, type VerifyFileSystem, type VerifyLayout } from "../compiler/verify.js";
import { workspaceFolder } from "./workspace.js";
import { costOf, type UsageReader } from "./budget.js";
import type { CompactionReader } from "./context.js";
import { chargeUsage, usageOwners } from "./cost.js";
import type { PermissionAsks } from "./permission.js";
import type { ResumeAction, ResumeActions } from "./resume.js";
import type { ToolStarts } from "./tool-start.js";
import {
  parseManifest,
  sessionContainersOf,
  workspaceOf,
  type ParsedManifest,
} from "./manifest.js";
import { Runner, StructureError, structureProblems, type RunnerDeps } from "./runner.js";
import type { RunStatus, Store } from "./store.js";
import type { TurnEndEvent, TurnEvents } from "./turns.js";
import type { HumanWaiter } from "./wait.js";

export type OpenSessionOptions = {
  sessionName: string;
  buildDir: string;
  model: string;
  socketPath: string;
  cwd: string;
  claudeSessionId: string;
  hooks: HookPaths;
  attach?: boolean;
  resume?: boolean;
  env?: Record<string, string>;
  sessionStatesPath?: string;
} & ({ layout: "legacy" } | { layout: "workspace"; workspaceFolder: string });

export type OpenedSession = {
  sessionId: string;
  session: { ensureStarted(): Promise<void> };
  prompts: RunnerDeps["prompts"];
  stop(): Promise<void>;
};

export type ExecuteDeps = {
  fs: VerifyFileSystem & Pick<RunnerDeps["files"], "writeFile">;
  waiter: HumanWaiter;
  startEvents(socketPath: string): Promise<{
    events: TurnEvents;
    permissions?: PermissionAsks;
    toolStarts?: ToolStarts;
    stop(): Promise<void>;
  }>;
  openSession(options: OpenSessionOptions): Promise<OpenedSession>;
  store: Store;
  onChange(line: string): void;
  onInterrupt?(handler: (exitCode: number) => void): () => void;
  now?: () => number;
  usage?: UsageReader;
  compactions?: CompactionReader;
};

export type RunEnvironment = Omit<ExecuteDeps, "store" | "onChange" | "onInterrupt">;

export type LoadedBuild = ParsedManifest & { cwd: string };

export interface StartedSessionsView {
  finish(): Promise<void>;
  started(): string[];
  failure(): { container: string; node: string } | undefined;
}

export type LoadBuildResult =
  { kind: "loaded"; build: LoadedBuild } | { kind: "error"; message: string };

export type Execution = {
  store: Store;
  runId: string;
  manifest: LoadedBuild;
  cwd: string;
  auto: boolean;
  socketPath: string;
  open(): Promise<OpenedSession>;
  actions?(): Promise<ResumeActions>;
  startedSessions?: StartedSessionsView;
};

const maxSocketPath = 104;

export const noClaude: OpenedSession = {
  sessionId: "",
  session: {
    ensureStarted: () => Promise.reject(new Error("This build has no Claude turns to start")),
  },
  prompts: {
    sendPrompt: () => Promise.reject(new Error("This build has no Claude turns to send")),
    interrupt: () => Promise.reject(new Error("This build has no Claude turns to interrupt")),
  },
  stop: async () => undefined,
};

export function runSocketPath(
  home: string,
  sessionName: string,
): { kind: "ok"; path: string } | { kind: "error"; message: string } {
  const path = `${home}/sockets/${sessionName}.sock`;
  return path.length > maxSocketPath
    ? { kind: "error", message: `Socket path "${path}" is longer than ${maxSocketPath} characters` }
    : { kind: "ok", path };
}

export async function loadBuild(
  buildId: string,
  deps: { fs: VerifyFileSystem; store: Pick<Store, "findBuild"> },
): Promise<LoadBuildResult> {
  const row = deps.store.findBuild(buildId);
  if (row === undefined) return { kind: "error", message: `No build ${buildId}` };
  const layout: VerifyLayout = row.name === null ? "legacy" : "workspace";
  const verified = await verify(row.dir, row.hash, layout, { fs: deps.fs });
  if (!verified.ok) {
    return {
      kind: "error",
      message: verified.problems.map(({ path, problem }) => `${path}: ${problem}`).join("\n"),
    };
  }
  const manifest = parseManifest(await deps.fs.readFile(`${row.dir}/manifest.json`), row);
  const { nodes, wires } = workspaceOf(manifest);
  const problems = structureProblems(nodes, wires);
  if (problems.length > 0) return { kind: "error", message: new StructureError(problems).message };
  return { kind: "loaded", build: { ...manifest, cwd: workspaceFolder(row.dir) } };
}

type NodesView = { nodes: readonly ManifestNode[] };

const checksACondition = (node: ManifestNode) =>
  node.type === "hardstop" && (node.settings as { condition: string }).condition.trim() !== "";

export const needsClaude = (manifest: NodesView) =>
  manifest.nodes.some((node) => node.type === "agent" || checksACondition(node));

type ResumeRead = { actions: ResumeActions; stop?: TurnEndEvent };

async function readUntilNoStop(
  events: TurnEvents,
  sessionId: string,
  read: () => Promise<ResumeActions>,
): Promise<ResumeRead> {
  let stops = 0;
  let stop: TurnEndEvent | undefined;
  const unsubscribe = events.subscribe("Stop", sessionId, (event) => {
    stops++;
    stop = event;
  });
  try {
    for (;;) {
      const stopsBefore = stops;
      const actions = await read();
      if (stops === stopsBefore) return stop === undefined ? { actions } : { actions, stop };
    }
  } finally {
    unsubscribe();
  }
}

function completeWaitWith(
  { actions, stop }: ResumeRead,
  turnNodes: ReadonlySet<string>,
): ResumeActions {
  if (stop === undefined) return actions;
  const message = stop.payload["last_assistant_message"];
  const complete: ResumeAction =
    typeof message === "string" ? { kind: "complete", stopMessage: message } : { kind: "complete" };
  return Object.fromEntries(
    Object.entries(actions).map(([nodeId, action]) => [
      nodeId,
      action.kind === "wait" && turnNodes.has(nodeId) ? complete : action,
    ]),
  );
}

const turnTypes = new Set(["agent", "fork", "hardstop"]);

export const turnNodeIds = (manifest: NodesView): Set<string> =>
  new Set(manifest.nodes.filter((node) => turnTypes.has(node.type)).map((node) => node.id));

export const parentsOf = (manifest: NodesView): Record<string, string> =>
  Object.fromEntries(
    manifest.nodes.flatMap((node) => (node.parent === undefined ? [] : [[node.id, node.parent]])),
  );

const containerOfSession = (
  store: Store,
  runId: string,
  manifest: LoadedBuild,
  sessionId: string,
): ManifestContainer => {
  const cwd = store.runSessions(runId).find((row) => row.claudeSessionId === sessionId)?.cwd;
  const session = sessionContainersOf(manifest).find(
    (container) => cwd !== undefined && container.worktree === cwd,
  );
  return session ?? workspaceOf(manifest);
};

async function recordSpend(
  store: Store,
  runId: string,
  manifest: LoadedBuild,
  usage: UsageReader | undefined,
  sessionIds: readonly string[],
  onChange: (line: string) => void,
): Promise<void> {
  const ids = sessionIds.filter((id) => id !== "");
  if (usage === undefined || ids.length === 0) return;
  try {
    const read = await Promise.all(
      ids.map(async (id) => ({
        container: containerOfSession(store, runId, manifest, id),
        entries: await usage.entries(id),
      })),
    );
    const events = store.events(runId);
    const charges = read.flatMap(({ container, entries }) =>
      chargeUsage({
        events,
        entries,
        turnNodes: turnNodeIds(container),
        owners: usageOwners(container, events),
        parents: parentsOf(container),
      }),
    );
    if (charges.length > 0) store.appendAll(runId, charges);
    store.recordCost(runId, costOf(read.flatMap(({ entries }) => entries)));
  } catch (error) {
    onChange(`cost not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writesUntil(store: Store, stopped: () => boolean): Store {
  return {
    createRun: (run) => store.createRun(run),
    findRun: (id) => store.findRun(id),
    runSessions: (runId) => store.runSessions(runId),
    nodeSessions: (runId) => store.nodeSessions(runId),
    listRuns: () => store.listRuns(),
    findRunSummary: (id) => store.findRunSummary(id),
    events: (id) => store.events(id),
    finishRun: (id, status) => store.finishRun(id, status),
    reopenRun: (id) => store.reopenRun(id),
    recordActivity: (id, entry) => store.recordActivity(id, entry),
    activity: (id) => store.activity(id),
    recordCost: (id, totalCost) => store.recordCost(id, totalCost),
    appendRunStory: (story) => store.appendRunStory(story),
    latestRunStory: (id) => store.latestRunStory(id),
    appendRepoState: (id, phase, state, otherRepos) =>
      store.appendRepoState(id, phase, state, otherRepos),
    repoStates: (id) => store.repoStates(id),
    appendStepText: (id, entryId, field, text) => store.appendStepText(id, entryId, field, text),
    stepTexts: (id, entryId) => store.stepTexts(id, entryId),
    appendOtherRepoBefore: (id, repo, state) => store.appendOtherRepoBefore(id, repo, state),
    appendBuildStepText: (pendingId, entryId, field, text) =>
      store.appendBuildStepText(pendingId, entryId, field, text),
    buildStepTexts: (pendingId, entryId) => store.buildStepTexts(pendingId, entryId),
    recordBuild: (build) => store.recordBuild(build),
    stopRun: (id) => store.stopRun(id),
    findBuild: (id) => store.findBuild(id),
    findBuildByName: (name) => store.findBuildByName(name),
    deleteBuild: (id) => store.deleteBuild(id),
    deleteRun: (runId) => store.deleteRun(runId),
    deletePendingBuild: (id) => store.deletePendingBuild(id),
    listBuilds: () => store.listBuilds(),
    addBuildWorktree: (buildId, worktree) => store.addBuildWorktree(buildId, worktree),
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
    storeManifest(manifest) {
      if (!stopped()) store.storeManifest(manifest);
    },
    append(id, nodeId, event) {
      if (!stopped()) store.append(id, nodeId, event);
    },
    appendAll(id, entries) {
      if (!stopped()) store.appendAll(id, entries);
    },
  };
}

export async function execute(deps: ExecuteDeps, execution: Execution): Promise<number> {
  const { store, runId, manifest, cwd, auto, socketPath, startedSessions } = execution;
  const workspace = workspaceOf(manifest);
  const events = await deps.startEvents(socketPath);
  let opened: OpenedSession | undefined;
  let stopping: Promise<void> | undefined;
  const stopAll = () =>
    (stopping ??= (async () => {
      try {
        await opened?.stop();
      } finally {
        await events.stop();
      }
    })());
  let stopListening: () => void = () => undefined;
  let wasInterrupted = false;
  const interrupted = new Promise<number>((resolve) => {
    if (deps.onInterrupt) {
      stopListening = deps.onInterrupt((code) => {
        wasInterrupted = true;
        void stopAll().then(() => resolve(code));
      });
    }
  });
  let status: Exclude<RunStatus, "running"> = "failed";
  try {
    opened = await execution.open();
    const actions =
      execution.actions === undefined
        ? {}
        : completeWaitWith(
            await readUntilNoStop(events.events, opened.sessionId, execution.actions),
            turnNodeIds(workspace),
          );
    const session = opened;
    const whileRunning = async <T>(step: () => Promise<T>): Promise<T> => {
      if (stopping) throw new Error("The run was stopped");
      return step();
    };
    const finished = new Runner({
      prompts: {
        sendPrompt: (text) => whileRunning(() => session.prompts.sendPrompt(text)),
        interrupt: () => whileRunning(() => session.prompts.interrupt()),
      },
      session: {
        ensureStarted: () =>
          whileRunning(async () => {
            await session.session.ensureStarted();
            if (stopping) {
              await session.stop();
              throw new Error("The run was stopped");
            }
          }),
      },
      events: events.events,
      waiter: deps.waiter,
      files: deps.fs,
      auto,
      onChange: (line) => deps.onChange(line),
      cwd,
      sessionId: opened.sessionId,
      store: writesUntil(store, () => wasInterrupted),
      runId,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(events.permissions === undefined ? {} : { permissions: events.permissions }),
      ...(deps.usage === undefined ? {} : { usage: deps.usage }),
      ...(deps.compactions === undefined ? {} : { compactions: deps.compactions }),
    })
      .run(
        {
          ...workspace,
          hash: manifest.hash,
          layout: manifest.layout,
          ...(manifest.values === undefined ? {} : { values: manifest.values }),
        },
        { actions },
      )
      .then((result) => (result.outcome === "done" ? 0 : 1));
    const code = await Promise.race([finished, interrupted]);
    if (code === 0) status = "done";
    return code;
  } finally {
    stopListening();
    await stopAll();
    await startedSessions?.finish();
    const sessionIds = [opened?.sessionId ?? "", ...(startedSessions?.started() ?? [])];
    await recordSpend(store, runId, manifest, deps.usage, sessionIds, deps.onChange);
    if (status === "done" && startedSessions?.failure() !== undefined) status = "failed";
    store.finishRun(runId, wasInterrupted ? "stopped" : status);
  }
}
