import type { ActivityEntry } from "../../core/run/activity.js";
import type { BuildProgress } from "../../core/run/build-progress.js";
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
    | "pin-flow"
    | "open-flow"
    | "list-runs"
    | "load-run"
    | "doctor"
    | "build-version"
    | "build-rebuild"
    | "build-progress-list"
    | "build-stop"
    | "build-activity"
    | "list-builds"
    | "build-files"
    | "run-build"
    | "run-options"
    | "stop-run"
    | "retry-node"
    | "resume-run"
    | "run-cost"
    | "answer-wait"
    | "workspace-info"
    | "list-branches"
    | "delete-build"
    | "doctor-worktrees"
    | "default-branch";
  payload?: unknown;
};

export type EngineResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export type EnginePush =
  | { push: "run-state"; value: RunSnapshot }
  | { push: "session"; runId: string; value: string | null }
  | { push: "activity"; value: { runId: string; entry: ActivityEntry } }
  | { push: "build-activity"; pendingId: string; entry: ActivityEntry }
  | { push: "wait"; runId: string; value: PendingWait | null }
  | {
      push: "build-progress";
      pendingId: string;
      flowId: string;
      progress: BuildProgress;
      buildId?: string;
    };

export type EngineMessage = EngineResponse | EnginePush;

export type BuildVersionStarted = { kind: "started"; pendingId: string };

export type StoreOpenResult = { kind: "ready" } | { kind: "error"; message: string };
