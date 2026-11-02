import type { ActivityEntry } from "../../core/run/activity.js";
import type { RunSnapshot } from "../../core/run/snapshot.js";
import type { PendingWait } from "../../core/run/wait.js";

export type EngineRequest = {
  id: number;
  type:
    | "version"
    | "store-status"
    | "save-flow"
    | "list-flows"
    | "rename-flow"
    | "open-flow"
    | "list-runs"
    | "load-run"
    | "doctor"
    | "build-version"
    | "list-builds"
    | "build-files"
    | "run-build"
    | "run-options"
    | "stop-run"
    | "retry-node"
    | "resume-run"
    | "run-cost"
    | "answer-wait"
    | "workspace-info";
  payload?: unknown;
};

export type EngineResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export type EnginePush =
  | { push: "run-state"; value: RunSnapshot }
  | { push: "session"; value: string | null }
  | { push: "activity"; value: { runId: string; entry: ActivityEntry } }
  | { push: "wait"; value: PendingWait | null };

export type EngineMessage = EngineResponse | EnginePush;

export type StoreOpenResult = { kind: "ready" } | { kind: "error"; message: string };
