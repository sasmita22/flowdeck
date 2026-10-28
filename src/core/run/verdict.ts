export type Verdict = { kind: "verdict"; done: boolean } | { kind: "malformed"; reason: string };

const opener = "```json";
const closer = "```";

const malformed = (reason: string): Verdict => ({ kind: "malformed", reason });

export function parseVerdict(reply: string | undefined): Verdict {
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed("done is not true or false");
  }
  const done: unknown = (value as Record<string, unknown>)["done"];
  if (typeof done !== "boolean") return malformed("done is not true or false");
  return { kind: "verdict", done };
}
