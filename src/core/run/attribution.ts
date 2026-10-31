export type NodeWindow = { nodeId: string; sentAt: number; endedAt?: number };

export function trackWindow(
  windows: readonly NodeWindow[],
  nodeId: string,
  kind: string,
  at: number,
): NodeWindow[] {
  if (kind === "sent") return [...windows, { nodeId, sentAt: at }];
  if (kind !== "done" && kind !== "failed" && kind !== "skipped") return [...windows];
  const open = windows.findLastIndex(
    (window) => window.nodeId === nodeId && window.endedAt === undefined,
  );
  return windows.map((window, index) => (index === open ? { ...window, endedAt: at } : window));
}

const covers = (window: NodeWindow, stamp: number) =>
  window.sentAt <= stamp && (window.endedAt === undefined || stamp < window.endedAt);

export const attribute = (
  windows: readonly NodeWindow[],
  stamp: number,
  owner?: string,
): string | undefined =>
  windows.find((window) => window.nodeId === owner && covers(window, stamp))?.nodeId ??
  windows.find((window) => covers(window, stamp))?.nodeId;
