import type { VariableValues } from "../flow/variables.js";
import { labelFor } from "../nodes/defaults.js";
import type { ActivityEntry } from "./activity.js";
import { usd } from "./budget.js";
import type { CostReport } from "./cost.js";
import { displayStatus } from "./display.js";
import type { StageNode, StageSources } from "./manifest.js";
import { pipelineOf, type PipelineItem, type PipelineStage } from "./pipeline.js";
import type { BuildRecord, RunStatus, StoredEvent } from "./store.js";
import type { HumanDecision } from "./wait.js";

export const digestCap = 12_000;

export type RunHeader = Pick<
  BuildRecord,
  "name" | "blueprintName" | "blueprintVersion" | "repo" | "values"
>;

export type RunDigest = { header: RunHeader; text: string };

export type DigestInput = {
  build: BuildRecord;
  stages: StageSources | null;
  events: readonly StoredEvent[];
  activity: readonly ActivityEntry[];
  cost: CostReport;
  createdAt: string;
  endedAt: string | null;
  status: RunStatus;
  questions: Readonly<Record<string, string>>;
};

type Limits = { reply: number; files: number; decision: number };

const whole = Number.POSITIVE_INFINITY;

const attempts: Limits[] = [
  { reply: whole, files: whole, decision: whole },
  { reply: 2000, files: whole, decision: whole },
  { reply: 500, files: whole, decision: whole },
  { reply: 100, files: whole, decision: whole },
  { reply: 100, files: 100, decision: whole },
  { reply: 100, files: 30, decision: whole },
  { reply: 100, files: 10, decision: whole },
  { reply: 100, files: 0, decision: whole },
  { reply: 100, files: 0, decision: 500 },
];

const tightest: Limits = { reply: 100, files: 0, decision: 100 };

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;

const nodesFromEvents = (events: readonly StoredEvent[]): StageNode[] =>
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

function stageLines(
  stage: PipelineStage,
  number: string,
  limits: Limits,
  questions: DigestInput["questions"],
): string[] {
  const facts = [
    displayStatus(stage.status),
    ...(stage.retries > 0 ? [`${stage.retries} ${stage.retries === 1 ? "retry" : "retries"}`] : []),
    ...(stage.ms === undefined ? [] : [`took ${Math.round(stage.ms / 1000)}s`]),
  ];
  const compactions = stage.timeline.filter((event) => event.kind === "compacted").length;
  const files = writtenPaths(stage.activity);
  const question = questions[stage.nodeId] ?? "";
  return [
    `${number}. ${labelFor(stage)} (${stage.type}): ${facts.join(", ")}`,
    ...(question === "" ? [] : [`   Asked: ${shortened(question, limits.decision)}`]),
    ...(stage.reason === undefined ? [] : [`   Reason: ${stage.reason}`]),
    ...stage.decisions.map((decision) => `   Decision: ${decisionLine(decision, limits.decision)}`),
    ...stage.budgetPauses.map(
      (pause) => `   Paused at its budget: ${usd(pause.spend)} spent of ${usd(pause.budget)}`,
    ),
    ...(compactions === 0 ? [] : [`   Context compacted ${compactions}×`]),
    ...(files.length === 0 ? [] : [`   Files written: ${filesLine(files, limits.files)}`]),
    ...(stage.reply === undefined
      ? []
      : [`   Final reply: ${shortened(stage.reply, limits.reply)}`]),
  ];
}

function itemLines(
  items: readonly PipelineItem[],
  prefix: string,
  limits: Limits,
  questions: DigestInput["questions"],
): string[] {
  return items.flatMap((item, index) => {
    const number = `${prefix}${index + 1}`;
    if ("lanes" in item) {
      return [
        `${number}. In parallel:`,
        ...item.lanes.flatMap((lane, at) =>
          itemLines(lane, `${number}.${at + 1}.`, limits, questions),
        ),
      ];
    }
    return [
      ...stageLines(item, number, limits, questions),
      ...(item.rounds ?? []).flatMap((round) => [
        `${number}. Round ${round.round}${round.item === undefined ? "" : ` (${round.item})`}:`,
        ...itemLines(round.items, `${number}.${round.round}.`, limits, questions),
      ]),
    ];
  });
}

export function runDigest(input: DigestInput): RunDigest {
  const { build } = input;
  const header: RunHeader = {
    name: build.name,
    blueprintName: build.blueprintName,
    blueprintVersion: build.blueprintVersion,
    repo: build.repo,
    values: build.values,
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
    `Variables: ${variablesLine(build.values)}`,
    `Run status: ${input.status}`,
    `Started: ${input.createdAt}`,
    `Ended: ${input.endedAt ?? "not recorded"}`,
    `Total cost: ${usd(input.cost.total.cost)}`,
    ...(pullRequests.length === 0 ? [] : [`Pull requests: ${pullRequests.join(", ")}`]),
  ];
  const textWith = (limits: Limits) =>
    [...facts, "Stages, in order:", ...itemLines(items, "", limits, input.questions)].join("\n");

  for (const limits of [...attempts, tightest]) {
    const text = textWith(limits);
    if (text.length <= digestCap) return { header, text };
  }
  return { header, text: shortened(textWith(tightest), digestCap - 1) };
}
