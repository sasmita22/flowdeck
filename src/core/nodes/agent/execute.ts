import type { Node } from "../../flow/schema.js";
import { nodeMarker, type AgentCall } from "../../run/agent-calls.js";
import { answerContext } from "../gate/execute.js";
import type { ProduceRow } from "./settings.js";

type AgentOutcome = "done" | "failed";

export type AgentTurnNode = { id: string; produces?: readonly ProduceRow[] };

export const agentTurnNode = (node: { id: string; settings: Node["settings"] }): AgentTurnNode => {
  const produces = producedRows(node.settings);
  return { id: node.id, ...(produces.length === 0 ? {} : { produces }) };
};

export const producedRows = (settings: object): readonly ProduceRow[] =>
  "produces" in settings && Array.isArray(settings.produces)
    ? (settings.produces as ProduceRow[])
    : [];

export function agentType(prefix: string, piece: string): string {
  return `${prefix}:${piece}`;
}

export const yesNoEntry = (name: string, answer: boolean): string =>
  `${JSON.stringify(name)}: ${String(answer)}`;

const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

export const producedObject = (names: readonly string[]): string =>
  `{${names.map((name) => yesNoEntry(name, true)).join(", ")}}`;

const namesOf = (rows: readonly ProduceRow[]) => rows.map((row) => row.variable);

function produceLines(rows: readonly ProduceRow[]): string {
  if (rows.length === 0) return "";
  const criteria = rows.map(
    (row) =>
      `- ${JSON.stringify(row.variable)}: true if ${oneLine(row.yesIf)}, false if ${oneLine(row.noIf)}`,
  );
  return [
    "Acceptance criteria: set each of these to true or false.",
    ...criteria,
    `End your reply with a fenced code block tagged json that holds one object with every one of them, for example ${producedObject(namesOf(rows))}.`,
  ].join("\n");
}

const relayRequest = (rows: readonly ProduceRow[]) =>
  `End your reply with a fenced code block tagged json that holds the object the agent ended with, every variable in it, for example ${producedObject(namesOf(rows))}.`;

export function agentPrompt(node: AgentTurnNode, answers: readonly string[] = []): string {
  return [nodeMarker(node.id), answerContext(answers), "Go", produceLines(node.produces ?? [])]
    .filter((line) => line !== "")
    .join("\n");
}

export function agentCallText(
  prefix: string,
  piece: string,
  node: AgentTurnNode,
  answers: readonly string[] = [],
): string {
  return `Use the Agent tool with subagent_type "${agentType(prefix, piece)}" and the prompt ${JSON.stringify(agentPrompt(node, answers))}.`;
}

export function agentTurnText(
  prefix: string,
  piece: string,
  node: AgentTurnNode,
  answers: readonly string[] = [],
): string {
  const rows = node.produces ?? [];
  const ending = rows.length === 0 ? "Then reply DONE." : relayRequest(rows);
  return `${agentCallText(prefix, piece, node, answers)} ${ending}`;
}

export function agentOutcome(calls: readonly AgentCall[], nodeId: string): AgentOutcome {
  return calls.some((call) => call.nodeId === nodeId && call.status !== undefined)
    ? "done"
    : "failed";
}
