import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { issueSummary } from "./status-look.js";
import { newCanvasFlow, selectNodeIssues, type CanvasState } from "./store.js";

export const CanvasStoreContext = createContext<StoreApi<CanvasState> | null>(null);

export const CanvasEditingContext = createContext(false);

const emptyFlow = newCanvasFlow();

const emptyCanvasStore: StoreApi<Pick<CanvasState, "flow">> = {
  getState: () => ({ flow: emptyFlow }),
  getInitialState: () => ({ flow: emptyFlow }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function NodeIssueMarker({ nodeId, width }: { nodeId: string; width: number }) {
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
        width,
        marginTop: 4,
        color: "var(--warn)",
        font: "11px/1.35 var(--f-body)",
      }}
    >
      {text}
    </span>
  );
}
