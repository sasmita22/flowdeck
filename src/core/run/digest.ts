import type { VariableValues } from "../flow/variables.js";
import { labelFor } from "../nodes/defaults.js";
import type { ActivityEntry } from "./activity.js";
import { usd } from "./budget.js";
import type { CostReport } from "./cost.js";
import { displayStatus } from "./display.js";
import type { StageNode, StageSources } from "./manifest.js";
import { pipelineOf, type PipelineItem, type PipelineStage } from "./pipeline.js";
import { otherReposText, repoStateText, type OtherRepo, type RunRepoStates } from "./repo-state.js";
import type { BuildRecord, RunStatus, StoredEvent } from "./store.js";
import type { HumanDecision } from "./wait.js";

export const digestCap = 12_000;

export type RunHeader = Pick<
  BuildRecord,
  "name" | "blueprintName" | "blueprintVersion" | "repo" | "branch" | "values"
> & { otherRepos?: OtherRepo[] };

export type RunDigest = { header: RunHeader; text: string };

type DigestStageNode = StageNode & { instructions?: string };

type DigestStages = Omit<StageSources, "nodes"> & { nodes: DigestStageNode[] };

export type DigestInput = {
  build: RunHeader & Pick<BuildRecord, "hash">;
  stages: DigestStages | null;
  events: readonly StoredEvent[];
  activity: readonly ActivityEntry[];
  cost: CostReport;
  createdAt: string;
  endedAt: string | null;
  status: RunStatus;
  questions: Readonly<Record<string, string>>;
  repoStates?: RunRepoStates;
};

type Limits = {
  steps: number;
  report: number;
  reply: number;
  files: number;
  decision: number;
  instructions: number;
};

const whole = Number.POSITIVE_INFINITY;

const untouched: Limits = {
  steps: whole,
  report: whole,
  reply: whole,
  files: whole,
  decision: whole,
  instructions: whole,
};

const cuts: Partial<Limits>[] = [
  { steps: 100 },
  { steps: 20 },
  { steps: 0 },
  { report: 2000 },
  { report: 500 },
  { report: 100 },
  { reply: 2000 },
  { reply: 500 },
  { reply: 100 },
  { files: 100 },
  { files: 30 },
  { files: 10 },
  { files: 0 },
  { decision: 500 },
  { decision: 100 },
  { instructions: 2000 },
  { instructions: 500 },
  { instructions: 100 },
];

const attempts: Limits[] = cuts.reduce<Limits[]>(
  (ladder, cut) => [...ladder, { ...(ladder.at(-1) ?? untouched), ...cut }],
  [untouched],
);

const tightest = attempts.at(-1) ?? untouched;

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;

const nodesFromEvents = (events: readonly StoredEvent[]): DigestStageNode[] =>
  [...new Set([...events].sort((a, b) => a.seq - b.seq).map((event) => event.nodeId))].map(
    (id) => ({ id, type: "agent", label: id }),
  );

export const variablesText = (values: VariableValues | null): string =>
  Object.entries(values ?? {})
    .map(([name, value]) => `${name} = ${String(value)}`)
    .join("; ");

const variablesLine = (values: VariableValues | null) => {
  const text = variablesText(values);
  return text === "" ? "none" : text;
};

const decisionLine = (decision: HumanDecision, limit: number) => {
  switch (decision.decision) {
    case "answered":
      return `answered: ${shortened(decision.answer, limit)}`;
    case "rejected":
    case "stopped":
      return `${decision.decision}: ${shortened(decision.reason, limit)}`;
    default:
      return decision.decision;
  }
};

const writtenPaths = (activity: readonly ActivityEntry[]) => [
  ...new Set(
    activity.flatMap((entry) =>
      entry.kind === "tool" && entry.path !== undefined ? [entry.path] : [],
    ),
  ),
];

const filesLine = (paths: readonly string[], limit: number) => {
  const kept = paths.slice(0, limit);
  const rest = paths.length - kept.length;
  return [...kept, ...(rest > 0 ? [`…and ${rest} more`] : [])].join(", ");
};

type ToolEntry = Extract<ActivityEntry, { kind: "tool" }>;

const stepLine = (entry: ToolEntry, runEnded: boolean) =>
  `     - ${[entry.tool, entry.summary].filter((part) => part !== "").join(" ")} → ${
    entry.result ?? (runEnded ? "not recorded" : "running")
  }`;

const stepsLines = (activity: readonly ActivityEntry[], limit: number, runEnded: boolean) => {
  const steps = activity.filter((entry): entry is ToolEntry => entry.kind === "tool");
  if (steps.length === 0) return [];
  const kept = steps.slice(0, limit);
  const rest = steps.length - kept.length;
  return [
    "   Steps:",
    ...kept.map((entry) => stepLine(entry, runEnded)),
    ...(rest > 0 ? [`     …and ${rest} more`] : []),
  ];
};

const reportOf = (activity: readonly ActivityEntry[]) =>
  activity.findLast(
    (entry): entry is Extract<ActivityEntry, { kind: "subagent" }> =>
      entry.kind === "subagent" && entry.report !== undefined,
  )?.report;

type StageRun = Pick<DigestInput, "questions" | "status"> & {
  instructions: ReadonlyMap<string, string>;
};

const agentLines = (stage: PipelineStage, limits: Limits, run: StageRun) => {
  if (stage.type !== "agent") return { asked: [], reported: [] };
  const instructions = run.instructions.get(stage.nodeId);
  const report = reportOf(stage.activity);
  return {
    asked: [
      `   Instructions: ${
        instructions === undefined ? "not recorded" : shortened(instructions, limits.instructions)
      }`,
    ],
    reported: [
      `   Report: ${report === undefined ? "not recorded" : shortened(report, limits.report)}`,
    ],
  };
};

function stageLines(stage: PipelineStage, number: string, limits: Limits, run: StageRun): string[] {
  const facts = [
    displayStatus(stage.status, run.status),
    ...(stage.retries > 0 ? [`${stage.retries} ${stage.retries === 1 ? "retry" : "retries"}`] : []),
    ...(stage.ms === undefined ? [] : [`took ${Math.round(stage.ms / 1000)}s`]),
  ];
  const compactions = stage.timeline.filter((event) => event.kind === "compacted").length;
  const files = writtenPaths(stage.activity);
  const question = run.questions[stage.nodeId] ?? "";
  const { asked, reported } = agentLines(stage, limits, run);
  return [
    `${number}. ${labelFor(stage)} (${stage.type}): ${facts.join(", ")}`,
    ...asked,
    ...(question === "" ? [] : [`   Asked: ${shortened(question, limits.decision)}`]),
    ...(stage.reason === undefined ? [] : [`   Reason: ${stage.reason}`]),
    ...stage.decisions.map((decision) => `   Decision: ${decisionLine(decision, limits.decision)}`),
    ...stage.budgetPauses.map(
      (pause) => `   Paused at its budget: ${usd(pause.spend)} spent of ${usd(pause.budget)}`,
    ),
    ...(compactions === 0 ? [] : [`   Context compacted ${compactions}×`]),
    ...(files.length === 0 ? [] : [`   Files written: ${filesLine(files, limits.files)}`]),
    ...stepsLines(stage.activity, limits.steps, run.status === "done" || run.status === "failed"),
    ...reported,
    ...(stage.reply === undefined
      ? []
      : [`   Final reply: ${shortened(stage.reply, limits.reply)}`]),
  ];
}

function itemLines(
  items: readonly PipelineItem[],
  prefix: string,
  limits: Limits,
  run: StageRun,
): string[] {
  return items.flatMap((item, index) => {
    const number = `${prefix}${index + 1}`;
    if ("lanes" in item) {
      return [
        `${number}. In parallel:`,
        ...item.lanes.flatMap((lane, at) => itemLines(lane, `${number}.${at + 1}.`, limits, run)),
      ];
    }
    return [
      ...stageLines(item, number, limits, run),
      ...(item.rounds ?? []).flatMap((round) => [
        `${number}. Round ${round.round}${round.item === undefined ? "" : ` (${round.item})`}:`,
        ...itemLines(round.items, `${number}.${round.round}.`, limits, run),
      ]),
    ];
  });
}

export function runDigest(input: DigestInput): RunDigest {
  const { build } = input;
  const otherRepos = input.repoStates?.otherRepos ?? [];
  const header: RunHeader = {
    name: build.name,
    blueprintName: build.blueprintName,
    blueprintVersion: build.blueprintVersion,
    repo: build.repo,
    branch: build.branch,
    values: build.values,
    ...(otherRepos.length === 0 ? {} : { otherRepos }),
  };
  const nodes = input.stages?.nodes ?? nodesFromEvents(input.events);
  const items = pipelineOf(
    nodes,
    input.stages?.wires ?? [],
    input.events,
    input.activity,
    input.cost,
  );
  const pullRequests = [
    ...new Set(input.activity.flatMap((entry) => (entry.kind === "pr" ? [entry.url] : []))),
  ];
  const facts = [
    `Blueprint: ${build.blueprintName ?? "unknown"}${
      build.blueprintVersion === null ? "" : `, version ${build.blueprintVersion}`
    }`,
    `Build: ${build.name ?? build.hash}`,
    ...(input.stages === null ? [] : [`Session: ${input.stages.session.name}`]),
    `Repo: ${build.repo ?? "none"}`,
    `Branch: ${build.branch ?? "none"}`,
    `Before: ${repoStateText(input.repoStates?.before ?? null)}`,
    `After: ${repoStateText(input.repoStates?.after ?? null)}`,
    ...(otherRepos.length === 0 ? [] : [`Other repos: ${otherReposText(otherRepos)}`]),
    `Variables: ${variablesLine(build.values)}`,
    `Run status: ${input.status}`,
    `Started: ${input.createdAt}`,
    `Ended: ${input.endedAt ?? "not recorded"}`,
    `Total cost: ${usd(input.cost.total.cost)}`,
    ...(pullRequests.length === 0 ? [] : [`Pull requests: ${pullRequests.join(", ")}`]),
  ];
  const run: StageRun = {
    questions: input.questions,
    status: input.status,
    instructions: new Map(
      nodes.flatMap((node) =>
        node.instructions === undefined ? [] : [[node.id, node.instructions] as const],
      ),
    ),
  };
  const textWith = (limits: Limits) =>
    [...facts, "Stages, in order:", ...itemLines(items, "", limits, run)].join("\n");

  for (const limits of attempts) {
    const text = textWith(limits);
    if (text.length <= digestCap) return { header, text };
  }
  return { header, text: shortened(textWith(tightest), digestCap - 1) };
}
