import type { RunEvent } from "./run-events.js";

export type RunStatus = "running" | "done" | "failed" | "stopped";

export type NewRun = {
  buildDir: string;
  inputs: Record<string, unknown>;
  nodeIds: string[];
  session: { tmuxName: string; cwd: string; claudeSessionId: string };
};

export type RunRecord = NewRun & { id: string; status: RunStatus };

export type StoredEvent = RunEvent & { nodeId: string; seq: number; time: string };

export type EventEntry = { nodeId: string; event: RunEvent };

export interface Store {
  createRun(run: NewRun): RunRecord;
  findRun(id: string): RunRecord | undefined;
  append(runId: string, nodeId: string, event: RunEvent): void;
  appendAll(runId: string, entries: readonly EventEntry[]): void;
  events(runId: string): StoredEvent[];
  finishRun(runId: string, status: Exclude<RunStatus, "running">): void;
}
