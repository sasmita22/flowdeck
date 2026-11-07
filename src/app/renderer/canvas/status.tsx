import { createContext, useContext, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BuildProgressState } from "../build-progress-store.js";
import { selectNodeDisplay, type RunView } from "../run-store.js";
import { issueSummary, statusBadge } from "./status-look.js";
import { newCanvasFlow, selectNodeIssues, type CanvasState } from "./store.js";

export const RunStoreContext = createContext<StoreApi<RunView> | null>(null);

export const CanvasStoreContext = createContext<StoreApi<CanvasState> | null>(null);

export const BuildAuditContext = createContext<{
  flowId: string;
  buildProgress: StoreApi<BuildProgressState>;
} | null>(null);

const emptyFlow = newCanvasFlow();

const emptyCanvasStore: StoreApi<Pick<CanvasState, "flow">> = {
  getState: () => ({ flow: emptyFlow }),
  getInitialState: () => ({ flow: emptyFlow }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const idleStore: StoreApi<RunView> = {
  getState: () => ({ snapshot: null }),
  getInitialState: () => ({ snapshot: null }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const noBuild: StoreApi<Pick<BuildProgressState, "isBuilding" | "nodeAuditStatus">> = {
  getState: () => ({ isBuilding: () => false, nodeAuditStatus: () => undefined }),
  getInitialState: () => ({ isBuilding: () => false, nodeAuditStatus: () => undefined }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function useNodeDisplay(nodeId: string) {
  const store = useContext(RunStoreContext);
  const status = useStore(store ?? idleStore, (state) => selectNodeDisplay(state, nodeId));
  return store === null ? null : status;
}

function useNodeAudit(nodeId: string) {
  const audit = useContext(BuildAuditContext);
  return useStore(audit?.buildProgress ?? noBuild, (state) =>
    audit !== null && state.isBuilding(audit.flowId)
      ? (state.nodeAuditStatus(audit.flowId, nodeId) ?? null)
      : null,
  );
}

export function NodeStatusBadge({ nodeId }: { nodeId: string }) {
  const display = useNodeDisplay(nodeId);
  const audit = useNodeAudit(nodeId);
  const status = display ?? audit;
  if (status === null) return null;
  const { label, color } = statusBadge(status);
  return (
    <span
      data-testid={`node-status-${nodeId}`}
      data-status={status}
      style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, fontSize: 11 }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }}
      />
      {label}
    </span>
  );
}

export function NodeFailureReason({ nodeId, style }: { nodeId: string; style?: CSSProperties }) {
  const store = useContext(RunStoreContext);
  const reason = useStore(store ?? idleStore, (state) =>
    state.snapshot?.nodes[nodeId] === "failed" ? state.snapshot.reasons?.[nodeId] : undefined,
  );
  if (store === null || reason === undefined) return null;
  return (
    <span
      data-testid={`node-reason-${nodeId}`}
      title={reason}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        width: 200,
        marginTop: 4,
        color: "#ef4444",
        font: "600 11px/1.35 var(--f-body)",
        ...style,
      }}
    >
      {reason}
    </span>
  );
}

export function NodeIssueMarker({ nodeId }: { nodeId: string }) {
  const store = useContext(CanvasStoreContext);
  const issues = useStore(
    store ?? emptyCanvasStore,
    (state) => selectNodeIssues(state.flow)[nodeId],
  );
  if (issues === undefined) return null;
  const { text, title } = issueSummary(issues);
  return (
    <span
      data-testid={`node-issue-${nodeId}`}
      title={title}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        width: 170,
        marginTop: 4,
        color: "var(--warn)",
        font: "11px/1.35 var(--f-body)",
      }}
    >
      {text}
    </span>
  );
}
