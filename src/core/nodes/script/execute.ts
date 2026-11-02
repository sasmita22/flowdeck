export type ScriptOutcome = "done" | "retry" | "failed";

export type ExitCodes = { successCodes?: readonly number[]; retryCodes?: readonly number[] };

const defaultSuccess = [0];
const defaultRetry = [2];
const maxAttempts = 2;

const listed = (codes: readonly number[] | undefined, fallback: readonly number[]) =>
  codes === undefined || codes.length === 0 ? fallback : codes;

export function scriptOutcome(
  code: number | null,
  attempt: number,
  codes: ExitCodes = {},
): ScriptOutcome {
  if (code === null) return "failed";
  if (listed(codes.successCodes, defaultSuccess).includes(code)) return "done";
  if (listed(codes.retryCodes, defaultRetry).includes(code) && attempt < maxAttempts) {
    return "retry";
  }
  return "failed";
}
