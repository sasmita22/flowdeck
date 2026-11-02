import { z } from "zod";
import { plainReason } from "./failure.js";
import { nodeStatus, type RunEvent } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { RunStatus } from "./store.js";

export type SnapshotStatus = RunStatus | "interrupted";

export interface RunSnapshot {
  runId: string;
  status: SnapshotStatus;
  nodes: Record<string, NodeState>;
  reasons?: Record<string, string> | undefined;
}

function failureOf(nodeId: string, events: readonly RunEvent[]): string | undefined {
  if (nodeStatus(events) !== "failed") return undefined;
  const failed = events.findLast((event) => event.kind === "failed");
  return failed?.kind === "failed" ? plainReason(nodeId, failed.payload.message) : undefined;
}

export function runSnapshot(input: {
  runId: string;
  status: SnapshotStatus;
  nodeIds: readonly string[];
  events: readonly (RunEvent & { nodeId: string })[];
}): RunSnapshot {
  const eventsOf = (id: string) => input.events.filter((event) => event.nodeId === id);
  const reasons = Object.fromEntries(
    input.nodeIds.flatMap((id) => {
      const reason = failureOf(id, eventsOf(id));
      return reason === undefined ? [] : [[id, reason]];
    }),
  );
  return {
    runId: input.runId,
    status: input.status,
    nodes: Object.fromEntries(input.nodeIds.map((id) => [id, nodeStatus(eventsOf(id))])),
    ...(Object.keys(reasons).length === 0 ? {} : { reasons }),
  };
}

export const snapshotStatusSchema = z.enum(["running", "done", "failed", "stopped", "interrupted"]);

const nodeStateSchema = z.enum([
  "waiting",
  "sent",
  "running",
  "needs-you",
  "skipped",
  "failed",
  "done",
]);

export const runSnapshotSchema: z.ZodType<RunSnapshot> = z.object({
  runId: z.string(),
  status: snapshotStatusSchema,
  nodes: z.record(z.string(), nodeStateSchema),
  reasons: z.record(z.string(), z.string()).optional(),
});

export type StartRunResult =
  { kind: "started"; runId: string } | { kind: "error"; message: string };

export const startRunResultSchema: z.ZodType<StartRunResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), runId: z.string() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
