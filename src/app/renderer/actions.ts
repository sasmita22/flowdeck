import type { StoreApi } from "zustand/vanilla";
import type { AssistantState } from "./assistant/assistant-store.js";
import type { BuildProgressState } from "./build-progress-store.js";
import type { LibraryState } from "./library-store.js";
import type { NavState } from "./nav-store.js";
import type { RunChoice, RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";

export type ActionStores = {
  nav: StoreApi<NavState>;
  save: StoreApi<Pick<SaveState, "flowId" | "error" | "open" | "startNew" | "leave" | "rename">>;
  run: StoreApi<
    Pick<
      RunState,
      | "runBuild"
      | "start"
      | "deleteBuild"
      | "stop"
      | "deleteRun"
      | "deletePendingBuild"
      | "writeStory"
    >
  >;
  library: StoreApi<Pick<LibraryState, "refresh" | "rename" | "delete">>;
  assistant: StoreApi<Pick<AssistantState, "end">>;
  buildProgress: StoreApi<Pick<BuildProgressState, "remove">>;
};

export type Actions = {
  newBlueprint(): Promise<void>;
  openBlueprint(flowId: string): Promise<void>;
  renameBlueprint(flowId: string, name: string): Promise<void>;
  deleteBlueprint(flowId: string): Promise<void>;
  runBuild(buildId: string): Promise<void>;
  startRun(choice: RunChoice): Promise<void>;
  deleteBuild(buildId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  deleteRun(runId: string): Promise<boolean>;
  deletePendingBuild(id: string): Promise<void>;
  writeStory(runId: string): Promise<void>;
};

export const createActions = ({
  nav,
  save,
  run,
  library,
  assistant,
  buildProgress,
}: ActionStores): Actions => {
  const toEditor = () => nav.getState().go({ name: "editor" });

  const showRun = async (started: Promise<string | null>) => {
    const runId = await started;
    void library.getState().refresh();
    if (runId !== null) nav.getState().go({ name: "run", runId });
  };

  return {
    newBlueprint: async () => {
      await save.getState().leave(async () => {
        await assistant.getState().end();
        save.getState().startNew();
        toEditor();
      });
    },
    openBlueprint: async (flowId) => {
      if (save.getState().flowId === flowId) {
        toEditor();
        return;
      }
      await save.getState().leave(async () => {
        await assistant.getState().end();
        await save.getState().open(flowId);
        const { error } = save.getState();
        if (error !== null) throw new Error(error);
        toEditor();
      });
    },
    renameBlueprint: async (flowId, name) => {
      if (save.getState().flowId === flowId) await save.getState().rename(name);
      else await library.getState().rename(flowId, name);
    },
    deleteBlueprint: async (flowId) => {
      const held = save.getState().flowId === flowId;
      if (!(await library.getState().delete(flowId)) || !held) return;
      await assistant.getState().end();
      save.getState().startNew();
    },
    runBuild: async (buildId) => {
      await run.getState().runBuild(buildId);
    },
    startRun: (choice) => showRun(run.getState().start(choice)),
    deleteBuild: async (buildId) => {
      await run.getState().deleteBuild(buildId);
      await library.getState().refresh();
    },
    stopRun: async (runId) => {
      await run.getState().stop(runId);
      await library.getState().refresh();
    },
    deleteRun: async (runId) => {
      const deleted = await run.getState().deleteRun(runId);
      await library.getState().refresh();
      return deleted;
    },
    deletePendingBuild: async (id) => {
      if (await run.getState().deletePendingBuild(id)) buildProgress.getState().remove(id);
      await library.getState().refresh();
    },
    writeStory: (runId) => run.getState().writeStory(runId),
  };
};
