import { z } from "zod";
import { buildReportSchema, type BuildReport } from "../compiler/build-report.js";
import { legacyBranchName } from "./branch-name.js";

const stepNumberSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
const componentKindSchema = z.enum(["agent", "template", "workspace", "shared"]);
const componentStatusSchema = z.enum(["waiting", "running", "done", "failed"]);
const stepStatusSchema = z.enum(["running", "done", "failed", "skipped"]);
export const buildOutcomeSchema = z.enum(["built", "needs-you", "failed", "stopped"]);

export type BuildStepNumber = z.infer<typeof stepNumberSchema>;
export type ComponentKind = z.infer<typeof componentKindSchema>;
export type ComponentStatus = z.infer<typeof componentStatusSchema>;
export type BuildOutcome = z.infer<typeof buildOutcomeSchema>;

const sessionEventSchema = z.object({
  type: z.literal("session"),
  name: z.string(),
  claudeSessionId: z.string(),
  buildId: z.string(),
  repo: z.string(),
  base: z.string(),
  values: z.record(z.string(), z.union([z.string(), z.boolean()])).readonly(),
  model: z.string().optional(),
  branch: z.string().optional(),
  branchCreated: z.boolean().optional(),
});

const buildCostSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  usd: z.number(),
});

export const buildEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    step: stepNumberSchema,
    status: stepStatusSchema,
    round: z.number().int().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("component"),
    path: z.string(),
    kind: componentKindSchema,
    nodeIds: z.array(z.string()),
    labels: z.array(z.string()).optional(),
    status: componentStatusSchema,
  }),
  sessionEventSchema,
  z.object({
    type: z.literal("worktree"),
    status: z.enum(["done", "failed"]),
    path: z.string(),
    branch: z.string(),
    base: z.string(),
    branchCreated: z.boolean().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("check-failed"),
    round: z.number().int(),
    failures: z.array(z.string()),
  }),
  z.object({ type: z.literal("merge"), nodeIds: z.array(z.string()), piece: z.string() }),
  buildCostSchema.extend({ type: z.literal("cost") }),
]);

export type BuildEvent = z.infer<typeof buildEventSchema>;
export type BuildSessionEvent = z.infer<typeof sessionEventSchema>;

export type StoredBuildEvent = BuildEvent & { seq: number; at: number };

export type SessionBranch = { branch: string; branchCreated: boolean };

export const sessionBranch = (
  event: BuildSessionEvent,
  name: string,
  buildId: string,
): SessionBranch =>
  event.branch === undefined
    ? { branch: legacyBranchName(name, buildId), branchCreated: true }
    : { branch: event.branch, branchCreated: event.branchCreated ?? true };

export type PendingBuild = {
  id: string;
  flowId: string;
  version: number;
  name: string;
  origin: unknown;
  startedAt: number;
  endedAt?: number;
  outcome?: BuildOutcome;
  buildId?: string;
  report?: unknown;
};

export const buildProgressSchema = z.object({
  steps: z.array(
    z.object({
      step: stepNumberSchema,
      status: z.union([z.literal("waiting"), stepStatusSchema]),
      round: z.number().exactOptional(),
      tookMs: z.number().exactOptional(),
      message: z.string().exactOptional(),
    }),
  ),
  components: z.array(
    z.object({
      path: z.string(),
      kind: componentKindSchema,
      nodeIds: z.array(z.string()),
      status: componentStatusSchema,
    }),
  ),
  cost: buildCostSchema.exactOptional(),
  questions: buildReportSchema.shape.questions.exactOptional(),
  chip: z.string(),
  outcomeLabel: z.string().exactOptional(),
  answerable: z.literal(true).exactOptional(),
});

const storedBuildEventSchema = buildEventSchema.and(z.object({ seq: z.number(), at: z.number() }));

export const buildProgressEntrySchema = z.object({
  pendingId: z.string(),
  name: z.string(),
  startedAt: z.number(),
  endedAt: z.number().exactOptional(),
  outcome: buildOutcomeSchema.exactOptional(),
  blueprintName: z.string().exactOptional(),
  blueprintVersion: z.number().exactOptional(),
  events: z.array(storedBuildEventSchema),
  progress: buildProgressSchema,
  buildId: z.string().exactOptional(),
});

export type BuildProgress = z.infer<typeof buildProgressSchema>;
export type BuildProgressEntry = z.infer<typeof buildProgressEntrySchema>;
export type StepProgress = BuildProgress["steps"][number];
export type ComponentProgress = BuildProgress["components"][number];
export type BuildCost = z.infer<typeof buildCostSchema>;
export type BuildQuestion = BuildReport["questions"][number];

const STEP_NUMBERS: readonly BuildStepNumber[] = [1, 2, 3, 4, 5];

const stepProgress = (step: BuildStepNumber, events: readonly StoredBuildEvent[]): StepProgress => {
  const own = events.filter(
    (event): event is StoredBuildEvent & { type: "step" } =>
      event.type === "step" && event.step === step,
  );
  const latest = own.at(-1);
  if (latest === undefined) return { step, status: "waiting" };
  const firstStart = own.find((event) => event.status === "running");
  const ended = latest.status === "done" || latest.status === "failed";
  return {
    step,
    status: latest.status,
    ...(latest.round === undefined ? {} : { round: latest.round }),
    ...(ended && firstStart !== undefined ? { tookMs: latest.at - firstStart.at } : {}),
    ...(latest.message === undefined ? {} : { message: latest.message }),
  };
};

const componentsOf = (events: readonly StoredBuildEvent[]): ComponentProgress[] => {
  const byPath = new Map<string, ComponentProgress>();
  for (const event of events) {
    if (event.type !== "component") continue;
    byPath.set(event.path, {
      path: event.path,
      kind: event.kind,
      nodeIds: event.nodeIds,
      status: event.status,
    });
  }
  return [...byPath.values()];
};

const latestCost = (events: readonly StoredBuildEvent[]): BuildCost | undefined => {
  const cost = events.findLast(
    (event): event is StoredBuildEvent & { type: "cost" } => event.type === "cost",
  );
  return cost === undefined
    ? undefined
    : { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, usd: cost.usd };
};

const OUTCOME_CHIP: Record<Exclude<BuildOutcome, "built">, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Failed",
};

const chipOf = (pending: PendingBuild, steps: readonly StepProgress[]): string => {
  if (pending.outcome === "built") return `Built · v${pending.version}`;
  if (pending.outcome !== undefined) return OUTCOME_CHIP[pending.outcome];
  const current = steps.findLast((step) => step.status !== "waiting")?.step ?? 1;
  return `Building · step ${current} of 5`;
};

const reportQuestions = (report: unknown): BuildQuestion[] => {
  const parsed = buildReportSchema.safeParse(report);
  if (!parsed.success) return [];
  return parsed.data.questions.map(({ otherNodeId, ...question }) =>
    otherNodeId === undefined ? question : { ...question, otherNodeId },
  );
};

export const progressOf = (
  pending: PendingBuild,
  events: readonly StoredBuildEvent[],
): BuildProgress => {
  const steps = STEP_NUMBERS.map((step) => stepProgress(step, events));
  const cost = latestCost(events);
  const chip = chipOf(pending, steps);
  const questions = reportQuestions(pending.report);
  return {
    steps,
    components: componentsOf(events),
    ...(cost === undefined ? {} : { cost }),
    ...(questions.length === 0 ? {} : { questions }),
    chip,
    ...(pending.outcome === undefined
      ? {}
      : { outcomeLabel: pending.outcome === "stopped" ? "Stopped" : chip }),
    ...(pending.outcome === "needs-you" ? { answerable: true as const } : {}),
  };
};

export type BuildingCard = {
  pendingId: string;
  buildName: string;
  blueprintName?: string;
  blueprintVersion?: number;
  startedAt: number;
  badge: string;
  live: boolean;
};

const ENDED_BADGE: Record<Exclude<BuildOutcome, "built">, string> = {
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Stopped",
};

const badgeOf = (
  outcome: Exclude<BuildOutcome, "built"> | undefined,
  events: readonly StoredBuildEvent[],
): string => {
  if (outcome !== undefined) return ENDED_BADGE[outcome];
  const current = events.findLast((event) => event.type === "step")?.step ?? 1;
  return `Building · step ${current} of 5`;
};

export const buildingCardOf = (entry: BuildProgressEntry): BuildingCard | undefined => {
  if (entry.outcome === "built") return undefined;
  return {
    pendingId: entry.pendingId,
    buildName: entry.name,
    ...(entry.blueprintName === undefined ? {} : { blueprintName: entry.blueprintName }),
    ...(entry.blueprintVersion === undefined ? {} : { blueprintVersion: entry.blueprintVersion }),
    startedAt: entry.startedAt,
    badge: badgeOf(entry.outcome, entry.events),
    live: entry.outcome === undefined,
  };
};
