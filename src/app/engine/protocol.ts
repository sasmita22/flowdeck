import type { VariableValues } from "../../core/flow/variables.js";
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
    | "default-branch"
    | "blueprint-session-start"
    | "blueprint-session-stop"
    | "blueprint-session-stop-all"
    | "assistant-list-builds"
    | "assistant-read-build";
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

export type AssistantBuildState = "live" | "deleted" | "old";

export type AssistantListedBuild = {
  id: string;
  name: string | null;
  blueprint: string | null;
  version: number | null;
  state: AssistantBuildState;
};

export type AssistantReadBuild = {
  repo: string | null;
  base: string | null;
  values: VariableValues | null;
  workspace: { path: string; exists: boolean; tree: string[] };
  worktree: {
    path: string;
    exists: boolean;
    dirty: boolean | null;
    unpushed: boolean | null;
  } | null;
};

export type BlueprintSessionStarted = { session: string };

export type BuildVersionStarted = { kind: "started"; pendingId: string };

export type StoreOpenResult = { kind: "ready" } | { kind: "error"; message: string };
