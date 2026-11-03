import type { VariableValues } from "../flow/variables.js";
import type { ActivityEntry } from "./activity.js";
import type { RunEvent } from "./run-events.js";

export type RunStatus = "running" | "done" | "failed" | "stopped";

export type NewRun = {
  buildDir: string;
  inputs: Record<string, unknown>;
  nodeIds: string[];
  session: { tmuxName: string; cwd: string; claudeSessionId: string };
  buildId: string;
};

export type BuildSource = { flowId: string; version: number };

export type BuildFileRecord = { path: string; sha256: string };

export type BuildNodeRecord = { nodeId: string; type: string; config: unknown; file?: string };

export type NewBuild = {
  id: string;
  hash: string;
  name: string;
  repo: string;
  base: string;
  values: VariableValues;
  dir: string;
  source?: BuildSource;
  files: BuildFileRecord[];
  nodes: BuildNodeRecord[];
};

export type BuildRecord = {
  id: string;
  hash: string;
  name: string | null;
  repo: string | null;
  base: string | null;
  values: VariableValues | null;
  deletedAt: number | null;
  dir: string;
  createdAt: number;
  source?: BuildSource;
};

export type RunRecord = Omit<NewRun, "buildId"> & {
  id: string;
  status: RunStatus;
  buildId?: string;
};

export type RunSummary = {
  id: string;
  status: RunStatus;
  buildId?: string;
  createdAt: string;
  endedAt: string | null;
  totalCost: number | null;
  nodeCount: number;
  source?: BuildSource;
};

export type StoredEvent = RunEvent & { nodeId: string; seq: number; time: string };

export type EventEntry = { nodeId: string; event: RunEvent };

export class BuildRunningError extends Error {
  constructor(buildId: string) {
    super(`build ${buildId} is running`);
    this.name = "BuildRunningError";
  }
}

export interface Store {
  createRun(run: NewRun): RunRecord;
  findRun(id: string): RunRecord | undefined;
  /** Every run, the running ones first, then the newest. */
  listRuns(): RunSummary[];
  append(runId: string, nodeId: string, event: RunEvent): void;
  appendAll(runId: string, entries: readonly EventEntry[]): void;
  events(runId: string): StoredEvent[];
  finishRun(runId: string, status: Exclude<RunStatus, "running">): void;
  reopenRun(runId: string): void;
  recordActivity(runId: string, entry: ActivityEntry): void;
  activity(runId: string): ActivityEntry[];
  recordCost(runId: string, totalCost: number): void;
  stopRun(runId: string): void;
  recordBuild(build: NewBuild): void;
  findBuild(id: string): BuildRecord | undefined;
  findBuildByName(name: string): BuildRecord | undefined;
  deleteBuild(id: string): void;
  listBuilds(): BuildRecord[];
  buildFiles(id: string): BuildFileRecord[];
}
