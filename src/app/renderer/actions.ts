import type { StoreApi } from "zustand/vanilla";
import type { LibraryState } from "./library-store.js";
import type { NavState } from "./nav-store.js";
import type { RunChoice, RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";

export type ActionStores = {
  nav: StoreApi<NavState>;
  save: StoreApi<Pick<SaveState, "flowId" | "open" | "startNew" | "leave" | "rename">>;
  run: StoreApi<Pick<RunState, "runBuild" | "start" | "deleteBuild" | "stop">>;
  library: StoreApi<Pick<LibraryState, "refresh" | "rename">>;
};

export type Actions = {
  newBlueprint(): Promise<void>;
  openBlueprint(flowId: string): Promise<void>;
  renameBlueprint(flowId: string, name: string): Promise<void>;
  runBuild(buildId: string): Promise<void>;
  startRun(choice: RunChoice): Promise<void>;
  deleteBuild(buildId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
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
    runBuild: (buildId) => showRun(run.getState().runBuild(buildId)),
    startRun: (choice) => showRun(run.getState().start(choice)),
    deleteBuild: async (buildId) => {
      await run.getState().deleteBuild(buildId);
      await library.getState().refresh();
    },
    stopRun: async (runId) => {
      await run.getState().stop(runId);
      await library.getState().refresh();
    },
  };
};
