export type ScriptOutcome = "done" | "retry" | "failed";

const retryCode = 2;
const maxAttempts = 2;

export function scriptOutcome(code: number | null, attempt: number): ScriptOutcome {
  if (code === 0) return "done";
  if (code === retryCode && attempt < maxAttempts) return "retry";
  return "failed";
}
