import type { RunEvent } from "./run-events.js";

export type RunStatus = "running" | "done" | "failed" | "stopped";

export type NewRun = {
  buildDir: string;
  inputs: Record<string, unknown>;
  nodeIds: string[];
  session: { tmuxName: string; cwd: string; claudeSessionId: string };
  buildHash: string;
};

export type BuildSource = { flowId: string; version: number };

export type BuildFileRecord = { path: string; sha256: string };

export type BuildNodeRecord = { nodeId: string; type: string; config: unknown; file?: string };

export type NewBuild = {
  hash: string;
  dir: string;
  source?: BuildSource;
  files: BuildFileRecord[];
  nodes: BuildNodeRecord[];
};

export type BuildRecord = { hash: string; dir: string; createdAt: number; source?: BuildSource };

export type RunRecord = Omit<NewRun, "buildHash"> & {
  id: string;
  status: RunStatus;
  buildHash?: string;
};

export type RunSummary = {
  id: string;
  status: RunStatus;
  buildHash?: string;
  createdAt: string;
  endedAt: string | null;
  totalCost: number | null;
  nodeCount: number;
  source?: BuildSource;
};

export type StoredEvent = RunEvent & { nodeId: string; seq: number; time: string };

export type EventEntry = { nodeId: string; event: RunEvent };

export interface Store {
  createRun(run: NewRun): RunRecord;
  findRun(id: string): RunRecord | undefined;
  /** Every run, the running ones first, then the newest. */
  listRuns(): RunSummary[];
  append(runId: string, nodeId: string, event: RunEvent): void;
  appendAll(runId: string, entries: readonly EventEntry[]): void;
  events(runId: string): StoredEvent[];
  finishRun(runId: string, status: Exclude<RunStatus, "running">): void;
  recordCost(runId: string, totalCost: number): void;
  recordBuild(build: NewBuild): void;
  findBuild(hash: string): BuildRecord | undefined;
  listBuilds(): BuildRecord[];
  buildFiles(hash: string): BuildFileRecord[];
}
