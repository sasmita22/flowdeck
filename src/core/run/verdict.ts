import { verdictKey } from "../nodes/agent/settings.js";

export type Verdict = { kind: "verdict"; done: boolean } | { kind: "malformed"; reason: string };

export type ProducedValue =
  { kind: "value"; answer: boolean } | { kind: "malformed"; reason: string };

type Malformed = { kind: "malformed"; reason: string };

const opener = "```json";
const closer = "```";

const malformed = (reason: string): Malformed => ({ kind: "malformed", reason });

function yesNoUnder(key: string, reply: string | undefined): boolean | Malformed {
  if (reply === undefined) return malformed("no reply");
  const start = reply.lastIndexOf(opener);
  if (start === -1) return malformed("no json block");
  const bodyStart = start + opener.length;
  const end = reply.indexOf(closer, bodyStart);
  if (end === -1) return malformed("unterminated json block");
  let value: unknown;
  try {
    value = JSON.parse(reply.slice(bodyStart, end).trim());
  } catch {
    return malformed("invalid json");
  }
  const answer: unknown =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof answer === "boolean" ? answer : malformed(`${key} is not true or false`);
}

export function parseVerdict(reply: string | undefined): Verdict {
  const done = yesNoUnder(verdictKey, reply);
  return typeof done === "boolean" ? { kind: "verdict", done } : done;
}

export function parseProducedValue(reply: string | undefined, name: string): ProducedValue {
  const answer = yesNoUnder(name, reply);
  return typeof answer === "boolean" ? { kind: "value", answer } : answer;
}
