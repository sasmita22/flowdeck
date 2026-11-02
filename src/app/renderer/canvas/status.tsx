import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { selectNodeDisplay, type RunState } from "../run-store.js";
import { statusBadge } from "./status-look.js";
import { newCanvasFlow, selectNodeIssues, type CanvasState } from "./store.js";

export const RunStoreContext = createContext<StoreApi<RunState> | null>(null);

export const CanvasStoreContext = createContext<StoreApi<CanvasState> | null>(null);

const emptyFlow = newCanvasFlow();

const emptyCanvasStore: StoreApi<Pick<CanvasState, "flow">> = {
  getState: () => ({ flow: emptyFlow }),
  getInitialState: () => ({ flow: emptyFlow }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const idleStore: StoreApi<Pick<RunState, "snapshot">> = {
  getState: () => ({ snapshot: null }),
  getInitialState: () => ({ snapshot: null }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function useNodeDisplay(nodeId: string) {
  const store = useContext(RunStoreContext);
  const status = useStore(store ?? idleStore, (state) => selectNodeDisplay(state, nodeId));
  return store === null ? null : status;
}

export function NodeStatusBadge({ nodeId }: { nodeId: string }) {
  const status = useNodeDisplay(nodeId);
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

export function NodeIssueMarker({ nodeId }: { nodeId: string }) {
  const store = useContext(CanvasStoreContext);
  const issue = useStore(
    store ?? emptyCanvasStore,
    (state) => selectNodeIssues(state.flow)[nodeId],
  );
  if (issue === undefined) return null;
  return (
    <span
      data-testid={`node-issue-${nodeId}`}
      title={issue}
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
      {issue}
    </span>
  );
}
