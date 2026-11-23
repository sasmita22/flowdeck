import type { VariableValues } from "../flow/variables.js";
import type { ActivityEntry } from "./activity.js";
import type { BuildEvent, BuildOutcome, PendingBuild, StoredBuildEvent } from "./build-progress.js";
import type { OtherRepo, RepoState, RunRepoStates } from "./repo-state.js";
import type { RunEvent } from "./run-events.js";

export type RunStatus = "running" | "done" | "failed" | "stopped";

export type RunSession = { tmuxName: string; cwd: string; claudeSessionId: string };

export type RunSessionRecord = RunSession & { parent: string | null };

export type NewRun = {
  buildDir: string;
  inputs: Record<string, unknown>;
  nodeIds: string[];
  session: RunSession;
  sessions?: (RunSession & { nodeIds?: string[] })[];
  buildId: string;
};

export type BuildSource = { flowId: string; version: number };

export type BuildFileRecord = { path: string; sha256: string };

export type BuildNodeRecord = { nodeId: string; type: string; config: unknown; file?: string };

export type NewBuild = {
  id: string;
  hash: string;
  name: string;
  repo: string | null;
  base: string | null;
  branch: string | null;
  branchCreated: boolean | null;
  values: VariableValues;
  dir: string;
  source?: BuildSource;
  files: BuildFileRecord[];
  nodes: BuildNodeRecord[];
  manifest: string;
};

export type BuildWorktree = {
  container: string;
  repo: string;
  base: string;
  branch: string;
  branchCreated: boolean;
  path: string;
};

export type BuildRecord = {
  id: string;
  hash: string;
  name: string | null;
  repo: string | null;
  base: string | null;
  branch: string | null;
  branchCreated: boolean | null;
  values: VariableValues | null;
  deletedAt: number | null;
  dir: string;
  createdAt: number;
  source?: BuildSource;
  blueprintName: string | null;
  blueprintVersion: number | null;
};

export type RunBuildCopy = {
  buildName: string | null;
  buildHash: string | null;
  blueprintName: string | null;
  source?: BuildSource;
  repo: string | null;
  branch: string | null;
  buildValues: VariableValues | null;
  manifestJson: string | null;
};

export type RunRecord = Omit<NewRun, "buildId" | "sessions"> &
  RunBuildCopy & {
    id: string;
    status: RunStatus;
    buildId?: string;
  };

export type RunSummary = {
  id: string;
  status: RunStatus;
  buildId?: string;
  createdAt: string;
  endedAt: string | null;
  totalCost: number | null;
  nodeCount: number;
  source?: BuildSource;
  buildName: string | null;
  blueprintName: string | null;
  blueprintVersion: number | null;
  buildGone: boolean;
  number: number;
  doneCount: number;
  storyLine?: string;
};

export type RunStory = {
  runId: string;
  at: string;
  runStatus: Exclude<RunStatus, "running">;
  text: string;
  cost: number;
};

export type RepoStatePhase = "before" | "after";

export type StepTextField = "input" | "output" | "report";

export type StepText = { field: StepTextField; text: string };

export type StoredEvent = RunEvent & { nodeId: string; seq: number; time: string };

export type EventEntry = { nodeId: string; event: RunEvent };

export type NewBuildSnapshot = { blueprintName: string; version: number; svg: string };

export type BuildSnapshot = NewBuildSnapshot & { pendingId: string | null; buildId: string | null };

export type SnapshotKey = { pendingId: string } | { buildId: string };

export type SnapshotGap = {
  pendingId: string | null;
  buildId: string | null;
  flowId: string | null;
  version: number | null;
  blueprintName: string | null;
};

export type NewPendingBuild = Pick<
  PendingBuild,
  "flowId" | "version" | "name" | "origin" | "startedAt"
> & { snapshot?: NewBuildSnapshot };

export type ManifestGap = { buildId: string; manifestSha256: string };

export type PendingBuildStart =
  { kind: "started"; pendingId: string } | { kind: "busy"; reason: "name" };

export type PendingBuildEnd = {
  outcome: BuildOutcome;
  endedAt: number;
  buildId?: string;
  report?: unknown;
};

export class BuildRunningError extends Error {
  constructor(buildId: string) {
    super(`build ${buildId} is running`);
    this.name = "BuildRunningError";
  }
}

export interface Store {
  createRun(run: NewRun): RunRecord;
  findRun(id: string): RunRecord | undefined;
  runSessions(runId: string): RunSessionRecord[];
  nodeSessions(runId: string): Record<string, string>;
  /** Every run, the running ones first, then the newest. */
  listRuns(): RunSummary[];
  findRunSummary(id: string): RunSummary | undefined;
  append(runId: string, nodeId: string, event: RunEvent): void;
  appendAll(runId: string, entries: readonly EventEntry[]): void;
  events(runId: string): StoredEvent[];
  finishRun(runId: string, status: Exclude<RunStatus, "running">): void;
  reopenRun(runId: string): void;
  recordActivity(runId: string, entry: ActivityEntry): void;
  activity(runId: string): ActivityEntry[];
  recordCost(runId: string, totalCost: number): void;
  appendRunStory(story: RunStory): void;
  latestRunStory(runId: string): RunStory | undefined;
  appendRepoState(
    runId: string,
    phase: RepoStatePhase,
    state: RepoState,
    otherRepos: OtherRepo[],
  ): void;
  appendOtherRepoBefore(runId: string, repo: string, state: RepoState): void;
  repoStates(runId: string): RunRepoStates;
  appendStepText(runId: string, entryId: number, field: StepTextField, text: string): void;
  stepTexts(runId: string, entryId: number): StepText[];
  appendBuildStepText(pendingId: string, entryId: number, field: StepTextField, text: string): void;
  buildStepTexts(pendingId: string, entryId: number): StepText[];
  stopRun(runId: string): void;
  deleteRun(runId: string): void;
  recordBuild(build: NewBuild): void;
  findBuild(id: string): BuildRecord | undefined;
  findBuildByName(name: string): BuildRecord | undefined;
  deleteBuild(id: string): void;
  listBuilds(): BuildRecord[];
  addBuildWorktree(buildId: string, worktree: BuildWorktree): void;
  buildWorktrees(buildId: string): BuildWorktree[];
  buildFiles(id: string): BuildFileRecord[];
  startPendingBuild(build: NewPendingBuild): PendingBuildStart;
  appendBuildEvent(pendingId: string, event: BuildEvent): void;
  buildEvents(pendingId: string): StoredBuildEvent[];
  endPendingBuild(pendingId: string, end: PendingBuildEnd): void;
  listPendingBuilds(): PendingBuild[];
  listLatestEndedPendingBuildsByName(): PendingBuild[];
  findPendingBuildByName(name: string): PendingBuild | undefined;
  pendingBuild(id: string): PendingBuild | null;
  deletePendingBuild(id: string): void;
  appendBuildActivity(pendingId: string, entry: ActivityEntry): void;
  buildActivity(pendingId: string): ActivityEntry[];
  buildSnapshot(key: SnapshotKey): BuildSnapshot | null;
  listSnapshotGaps(): SnapshotGap[];
  addSnapshotIfMissing(
    gap: Pick<SnapshotGap, "pendingId" | "buildId">,
    snapshot: NewBuildSnapshot,
  ): boolean;
  storeManifest(manifest: { buildId: string; manifest: string }): void;
  buildManifest(buildId: string): string | undefined;
  listManifestGaps(): ManifestGap[];
}
