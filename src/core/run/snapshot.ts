import { z } from "zod";
import { nodeStatus, type RunEvent } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { RunStatus } from "./store.js";

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
}

export function runSnapshot(input: {
  runId: string;
  status: RunStatus;
  nodeIds: readonly string[];
  events: readonly (RunEvent & { nodeId: string })[];
}): RunSnapshot {
  return {
    runId: input.runId,
    status: input.status,
    nodes: Object.fromEntries(
      input.nodeIds.map((id) => [
        id,
        nodeStatus(input.events.filter((event) => event.nodeId === id)),
      ]),
    ),
  };
}

const runStatusSchema = z.enum(["running", "done", "failed", "stopped"]);

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
  status: runStatusSchema,
  nodes: z.record(z.string(), nodeStateSchema),
});

export type StartRunResult =
  { kind: "started"; runId: string } | { kind: "error"; message: string };

export const startRunResultSchema: z.ZodType<StartRunResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), runId: z.string() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
