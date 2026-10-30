import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { selectNodeDisplay, type RunState } from "../run-store.js";
import { statusBadge } from "./status-look.js";

export const RunStoreContext = createContext<StoreApi<RunState> | null>(null);

const idleStore: StoreApi<Pick<RunState, "snapshot">> = {
  getState: () => ({ snapshot: null }),
  getInitialState: () => ({ snapshot: null }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function NodeStatusBadge({ nodeId }: { nodeId: string }) {
  const store = useContext(RunStoreContext);
  const status = useStore(store ?? idleStore, (state) => selectNodeDisplay(state, nodeId));
  if (store === null || status === null) return null;
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
