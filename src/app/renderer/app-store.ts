import { createStore } from "zustand/vanilla";
import type { FlowdeckBridge, StoreStatus } from "../preload/bridge.js";

export type AppState = {
  version: string | null;
  versionError: string | null;
  status: StoreStatus | { kind: "loading" };
  load(): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createAppStore = (bridge: FlowdeckBridge) =>
  createStore<AppState>()((set) => ({
    version: null,
    versionError: null,
    status: { kind: "loading" },
    load: async () => {
      await Promise.all([
        bridge.version().then(
          (version) => set({ version, versionError: null }),
          (error: unknown) => set({ version: null, versionError: messageOf(error) }),
        ),
        bridge.storeStatus().then(
          (status) => set({ status }),
          (error: unknown) => set({ status: { kind: "error", message: messageOf(error) } }),
        ),
      ]);
    },
  }));
