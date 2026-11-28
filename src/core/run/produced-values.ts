import { producedRows } from "../nodes/agent/execute.js";
import { parseProducedValues } from "./verdict.js";

export const replyOf = (event: { payload: Record<string, unknown> }): string | undefined => {
  const response = event.payload["tool_response"] as { content?: unknown } | undefined;
  const content = Array.isArray(response?.content) ? (response.content as unknown[]) : [];
  const texts = content.flatMap((part) => {
    const text = (part as { text?: unknown } | null)?.text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length === 0 ? undefined : texts.join("\n");
};

export const producedBy = (settings: object, message: string | undefined) =>
  parseProducedValues(
    message,
    producedRows(settings).map((row) => row.variable),
  );

export const missingReason = (missing: readonly string[]) =>
  `ended without setting ${missing.map((name) => JSON.stringify(name)).join(", ")}`;
