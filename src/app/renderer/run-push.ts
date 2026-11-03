export const pushFor = (value: unknown, runId: string | null): Record<string, unknown> | null => {
  if (runId === null || typeof value !== "object" || value === null) return null;
  const push = value as Record<string, unknown>;
  return push["runId"] === runId ? push : null;
};
