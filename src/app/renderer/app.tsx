import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "./app-store.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

export function App({ store }: { store: StoreApi<AppState> }) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  return (
    <main>
      <h1 data-testid="app-title">Flowdeck</h1>
      <p data-testid="app-version">{version}</p>
      <p data-testid="store-status">{status}</p>
    </main>
  );
}
