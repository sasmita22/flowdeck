import { createStore, type StoreApi } from "zustand/vanilla";
import {
  folderStateSchema,
  workspaceLabel,
  type FolderState,
  type WorkingFolder,
  type WorkspaceLabel,
} from "../../core/flow/workspace-info.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import type { CanvasState } from "./canvas/store.js";
import type { RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";

export type WorkspaceBridge = Pick<FlowdeckBridge, "workspaceInfo">;

export type WorkspaceState = {
  folder: WorkingFolder | null;
  state: FolderState | undefined;
};

export const selectWorkspaceLabel = (workspace: WorkspaceState): WorkspaceLabel | null =>
  workspace.folder === null ? null : workspaceLabel(workspace.folder, workspace.state);

const folderKey = (folder: WorkingFolder | null): string | null => {
  if (folder === null) return null;
  return folder.kind === "path"
    ? JSON.stringify([folder.kind, folder.path])
    : JSON.stringify([folder.kind, folder.branch, folder.repo ?? null]);
};

const replySchema = folderStateSchema.nullable();

export const createWorkspaceStore = ({
  bridge,
  canvas,
  save,
  run,
}: {
  bridge: WorkspaceBridge;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
}): StoreApi<WorkspaceState> => {
  const store = createStore<WorkspaceState>()(() => ({ folder: null, state: undefined }));
  let latest = 0;

  const refresh = async () => {
    const { ready, flow } = canvas.getState();
    if (!ready) return;
    const folder = flow.session.workingFolder;
    const asked = ++latest;
    const current = store.getState();
    store.setState({
      folder,
      state: folderKey(current.folder) === folderKey(folder) ? current.state : undefined,
    });
    let reply: unknown;
    try {
      reply = await bridge.workspaceInfo(folder);
    } catch {
      reply = undefined;
    }
    if (asked !== latest) return;
    const parsed = replySchema.safeParse(reply);
    store.setState({ state: parsed.success ? (parsed.data ?? undefined) : undefined });
  };

  canvas.subscribe((next, previous) => {
    if (!next.ready) return;
    const moved =
      folderKey(next.flow.session.workingFolder) !== folderKey(previous.flow.session.workingFolder);
    if (!previous.ready || moved) void refresh();
  });
  save.subscribe((next, previous) => {
    if (previous.saving && !next.saving && next.error === null) void refresh();
  });
  run.subscribe((next, previous) => {
    const runId = next.snapshot?.runId;
    if (runId !== undefined && runId !== previous.snapshot?.runId) void refresh();
  });
  void refresh();

  return store;
};
