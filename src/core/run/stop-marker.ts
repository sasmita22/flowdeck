type StopNode = { type: string; settings?: Record<string, unknown> };

export const stopsTheRun = (node: StopNode): boolean =>
  (node.type === "gate" && node.settings?.["stopWhen"] === "conditional") ||
  (node.type === "loop" && node.settings?.["onCap"] !== "ask");

const stopLead = "STOPPED NODE ";

export function stopMarker(nodeId: string): string {
  return `${stopLead}${nodeId}`;
}

export function stoppedNodeOf(message: string | undefined): string | undefined {
  const last = (message ?? "")
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");
  const line = last?.replace(/^`(.*)`$/, "$1");
  if (line === undefined || !line.startsWith(stopLead)) return undefined;
  const nodeId = line.slice(stopLead.length);
  return /^\S+$/.test(nodeId) ? nodeId : undefined;
}
