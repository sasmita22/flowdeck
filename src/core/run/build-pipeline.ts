import type { ActivityEntry } from "./activity.js";
import type {
  BuildCost,
  BuildEvent,
  BuildOutcome,
  BuildStepNumber,
  ComponentKind,
  ComponentStatus,
  PendingBuild,
  StepProgress,
  StoredBuildEvent,
} from "./build-progress.js";

type Stored<T extends BuildEvent["type"]> = StoredBuildEvent & { type: T };

export type PipelineWorktree = Omit<Extract<BuildEvent, { type: "worktree" }>, "type">;

export type PipelineRow = {
  path: string;
  kind: ComponentKind;
  status: ComponentStatus;
  labels: string[];
  merged: boolean;
  log: ActivityEntry[];
};

export type PipelineLane = {
  step: BuildStepNumber;
  round: number;
  status: StepProgress["status"];
  durationMs?: number;
  message?: string;
  failures?: string[];
  worktrees?: PipelineWorktree[];
  rows: PipelineRow[];
  log: ActivityEntry[];
};

export type PipelineHeader = {
  name: string;
  startedAt: number;
  endedAt?: number;
  status: BuildOutcome | "building";
  repo?: string;
  base?: string;
  branch?: string;
  path?: string;
  model?: string;
  cost?: BuildCost;
};

export type BuildPipeline = {
  header: PipelineHeader;
  lanes: PipelineLane[];
  blockedLane?: { step: BuildStepNumber; round: number };
};

type LaneEvents = {
  step: BuildStepNumber;
  round: number;
  steps: Stored<"step">[];
  components: Map<string, Stored<"component">>;
  merged: Set<string>;
};

const STEP_NUMBERS: readonly BuildStepNumber[] = [1, 2, 3, 4, 5];

const keyOf = (step: BuildStepNumber, round: number) => `${step}:${round}`;

const roundOf = (event: Stored<"step">) => event.round ?? 1;

const emptyLane = (step: BuildStepNumber, round: number): LaneEvents => ({
  step,
  round,
  steps: [],
  components: new Map(),
  merged: new Set(),
});

const laneEventsOf = (events: readonly StoredBuildEvent[]): LaneEvents[] => {
  const lanes = new Map(STEP_NUMBERS.map((step) => [keyOf(step, 1), emptyLane(step, 1)]));
  let current: LaneEvents | undefined;
  for (const event of events) {
    if (event.type === "step") {
      const key = keyOf(event.step, roundOf(event));
      current = lanes.get(key) ?? emptyLane(event.step, roundOf(event));
      lanes.set(key, current);
      current.steps.push(event);
    } else if (event.type === "component") {
      current?.components.set(event.path, event);
    } else if (event.type === "merge") {
      current?.merged.add(event.piece);
    }
  }
  return [...lanes.values()].sort((a, b) => a.round - b.round || a.step - b.step);
};

const worktreeOf = (event: Stored<"worktree">): PipelineWorktree => ({
  status: event.status,
  path: event.path,
  branch: event.branch,
  base: event.base,
  ...(event.message === undefined ? {} : { message: event.message }),
});

const laneOf = (
  lane: LaneEvents,
  events: readonly StoredBuildEvent[],
  activity: readonly ActivityEntry[],
): PipelineLane => {
  const latest = lane.steps.at(-1);
  const start = lane.steps.find((event) => event.status === "running");
  const closed = latest?.status === "done" || latest?.status === "failed" ? latest : undefined;
  const end = closed?.at ?? Infinity;
  const log =
    start === undefined ? [] : activity.filter((entry) => entry.at >= start.at && entry.at <= end);
  const checkFailed = events.findLast(
    (event): event is Stored<"check-failed"> =>
      lane.step === 5 && event.type === "check-failed" && event.round === lane.round,
  );
  const worktrees = events.filter(
    (event): event is Stored<"worktree"> => lane.step === 2 && event.type === "worktree",
  );
  const rows = [...lane.components.values()].map((component): PipelineRow => ({
    path: component.path,
    kind: component.kind,
    status: component.status,
    labels: component.labels ?? component.nodeIds,
    merged: lane.merged.has(component.path),
    log: log.filter((entry) => entry.nodeId === component.path),
  }));
  return {
    step: lane.step,
    round: lane.round,
    status: latest?.status ?? "waiting",
    ...(closed !== undefined && start !== undefined ? { durationMs: closed.at - start.at } : {}),
    ...(latest?.message === undefined ? {} : { message: latest.message }),
    ...(checkFailed === undefined ? {} : { failures: checkFailed.failures }),
    ...(worktrees.length === 0 ? {} : { worktrees: worktrees.map(worktreeOf) }),
    rows,
    log,
  };
};

const headerOf = (
  pending: Pick<PendingBuild, "name" | "startedAt" | "endedAt" | "outcome">,
  events: readonly StoredBuildEvent[],
): PipelineHeader => {
  const session = events.findLast((event): event is Stored<"session"> => event.type === "session");
  const worktrees = events.filter(
    (event): event is Stored<"worktree"> => event.type === "worktree",
  );
  const worktree = worktrees.at(-1);
  const cost = events.findLast((event): event is Stored<"cost"> => event.type === "cost");
  const oneRepo = worktrees.length <= 1 && session?.repo !== "";
  const base = worktree?.branchCreated === false ? undefined : (worktree?.base ?? session?.base);
  return {
    name: pending.name,
    startedAt: pending.startedAt,
    ...(pending.endedAt === undefined ? {} : { endedAt: pending.endedAt }),
    status: pending.outcome ?? "building",
    ...(session === undefined || !oneRepo ? {} : { repo: session.repo }),
    ...(base === undefined || !oneRepo ? {} : { base }),
    ...(worktree === undefined || !oneRepo ? {} : { branch: worktree.branch, path: worktree.path }),
    ...(session?.model === undefined ? {} : { model: session.model }),
    ...(cost === undefined
      ? {}
      : {
          cost: { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, usd: cost.usd },
        }),
  };
};

export const buildPipelineOf = (
  pending: Pick<PendingBuild, "id" | "name" | "startedAt" | "endedAt" | "outcome" | "buildId">,
  events: readonly StoredBuildEvent[],
  activity: readonly ActivityEntry[],
): BuildPipeline => {
  const blocked =
    pending.outcome === "needs-you"
      ? events.findLast((event): event is Stored<"step"> => event.type === "step")
      : undefined;
  return {
    header: headerOf(pending, events),
    lanes: laneEventsOf(events).map((lane) => laneOf(lane, events, activity)),
    ...(blocked === undefined
      ? {}
      : { blockedLane: { step: blocked.step, round: roundOf(blocked) } }),
  };
};
