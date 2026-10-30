export type NodeWindow = { nodeId: string; sentAt: number; endedAt?: number };

export function trackWindow(
  windows: readonly NodeWindow[],
  nodeId: string,
  kind: string,
  at: number,
): NodeWindow[] {
  if (kind === "sent") return [...windows, { nodeId, sentAt: at }];
  if (kind !== "done" && kind !== "failed") return [...windows];
  const open = windows.findLastIndex(
    (window) => window.nodeId === nodeId && window.endedAt === undefined,
  );
  return windows.map((window, index) => (index === open ? { ...window, endedAt: at } : window));
}

export const attribute = (windows: readonly NodeWindow[], stamp: number): string | undefined =>
  windows.find(
    (window) => window.sentAt <= stamp && (window.endedAt === undefined || stamp < window.endedAt),
  )?.nodeId;
