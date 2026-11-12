import { declaredHandoff, handoffText, type Handoff } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { nodeMarker, type AgentCall } from "../../run/agent-calls.js";
import { answerContext } from "../ask/execute.js";
import { withItem } from "../foreach/execute.js";
import { producedName } from "./settings.js";

export type AgentOutcome = "done" | "failed";

export type AgentTurnNode = { id: string; produces?: string } & Handoff;

export const agentTurnNode = (node: { id: string; settings: Node["settings"] }): AgentTurnNode => {
  const produces = producedName(node.settings);
  return {
    id: node.id,
    ...declaredHandoff(node.settings),
    ...(produces === undefined ? {} : { produces }),
  };
};

export function agentType(prefix: string, piece: string): string {
  return `${prefix}:${piece}`;
}

export const yesNoEntry = (name: string, answer: boolean): string =>
  `${JSON.stringify(name)}: ${String(answer)}`;

function answerRequest(name: string): string {
  return `End your reply with a fenced code block tagged json that holds your yes/no answer for ${JSON.stringify(name)}: {${yesNoEntry(name, true)}} for yes, else {${yesNoEntry(name, false)}}.`;
}

export function agentPrompt(
  node: AgentTurnNode,
  item?: string,
  answers: readonly string[] = [],
): string {
  const go = item === undefined ? "Go" : withItem("Go.", item);
  const answer = node.produces === undefined ? "" : answerRequest(node.produces);
  return [nodeMarker(node.id), handoffText(node).trim(), answerContext(answers), go, answer]
    .filter((line) => line !== "")
    .join("\n");
}

export function agentCallText(
  prefix: string,
  piece: string,
  node: AgentTurnNode,
  item?: string,
  answers: readonly string[] = [],
): string {
  const dispatched = { id: node.id, given: node.given, writes: node.writes };
  return `Use the Agent tool with subagent_type "${agentType(prefix, piece)}" and the prompt ${JSON.stringify(agentPrompt(dispatched, item, answers))}.`;
}

export function agentTurnText(
  prefix: string,
  piece: string,
  node: AgentTurnNode,
  item?: string,
  answers: readonly string[] = [],
): string {
  const ending = node.produces === undefined ? "Then reply DONE." : answerRequest(node.produces);
  return `${agentCallText(prefix, piece, node, item, answers)} ${ending}`;
}

export function agentOutcome(calls: readonly AgentCall[], nodeId: string): AgentOutcome {
  return calls.some((call) => call.nodeId === nodeId && call.status !== undefined)
    ? "done"
    : "failed";
}
