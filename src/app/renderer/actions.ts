import type { StoreApi } from "zustand/vanilla";
import type { LibraryState } from "./library-store.js";
import type { NavState } from "./nav-store.js";
import type { RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";

export type ActionStores = {
  nav: StoreApi<NavState>;
  save: StoreApi<Pick<SaveState, "flowId" | "open" | "startNew" | "leave" | "rename">>;
  run: StoreApi<Pick<RunState, "run" | "runBuild">>;
  library: StoreApi<Pick<LibraryState, "refresh" | "rename">>;
};

export type Actions = {
  newBlueprint(): Promise<void>;
  openBlueprint(flowId: string): Promise<void>;
  renameBlueprint(flowId: string, name: string): Promise<void>;
  buildAndRun(): Promise<void>;
  runBuild(hash: string): Promise<void>;
};

export const createActions = ({ nav, save, run, library }: ActionStores): Actions => {
  const toEditor = () => nav.getState().go({ name: "editor" });

  const showRun = async (started: Promise<string | null>) => {
    const runId = await started;
    void library.getState().refresh();
    if (runId !== null) nav.getState().go({ name: "run", runId });
  };

  return {
    newBlueprint: () =>
      save.getState().leave(async () => {
        save.getState().startNew();
        toEditor();
      }),
    openBlueprint: async (flowId) => {
      if (save.getState().flowId === flowId) {
        toEditor();
        return;
      }
      await save.getState().leave(async () => {
        await save.getState().open(flowId);
        toEditor();
      });
    },
    renameBlueprint: async (flowId, name) => {
      if (save.getState().flowId === flowId) await save.getState().rename(name);
      else await library.getState().rename(flowId, name);
    },
    buildAndRun: () => showRun(run.getState().run()),
    runBuild: (hash) => showRun(run.getState().runBuild(hash)),
  };
};
