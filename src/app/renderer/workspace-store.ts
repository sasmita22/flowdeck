import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BuildConfig } from "../../core/flow/schema.js";
import {
  folderStateSchema,
  type FolderState,
  type WorkspaceLabel,
} from "../../core/flow/workspace-info.js";
import { repoFolder } from "../../core/run/workspace.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import type { CanvasState } from "./canvas/store.js";
import type { SaveState } from "./save-store.js";

export type WorkspaceBridge = Pick<FlowdeckBridge, "workspaceInfo">;

export type WorkspaceInfo = { state: FolderState; base: string | null } | null;

export type WorkspaceState = {
  folder: BuildConfig | null;
  info: WorkspaceInfo | undefined;
};

export const selectWorkspaceLabel = ({ folder, info }: WorkspaceState): WorkspaceLabel | null => {
  if (folder === null) return null;
  return {
    folder: folder.repo
      ? { name: repoFolder(folder.repo), title: folder.repo }
      : { name: "repo not set", title: "" },
    branch: info === undefined ? "" : (info?.base ?? "default branch"),
  };
};

const folderKey = (folder: BuildConfig | null): string | null =>
  folder === null ? null : JSON.stringify([folder.repo ?? null, folder.base ?? null]);

const replySchema = z.object({ state: folderStateSchema, base: z.string().nullable() }).nullable();

export const createWorkspaceStore = ({
  bridge,
  canvas,
  save,
}: {
  bridge: WorkspaceBridge;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
}): StoreApi<WorkspaceState> => {
  const store = createStore<WorkspaceState>()(() => ({ folder: null, info: undefined }));
  let latest = 0;

  const refresh = async () => {
    const { ready, flow } = canvas.getState();
    if (!ready) return;
    const folder = flow.session.buildConfig;
    const asked = ++latest;
    const current = store.getState();
    store.setState({
      folder,
      info: folderKey(current.folder) === folderKey(folder) ? current.info : undefined,
    });
    let reply: unknown;
    try {
      reply = await bridge.workspaceInfo(folder);
    } catch {
      reply = undefined;
    }
    if (asked !== latest) return;
    const parsed = replySchema.safeParse(reply);
    store.setState({ info: parsed.success ? parsed.data : undefined });
  };

  canvas.subscribe((next, previous) => {
    if (!next.ready) return;
    const moved =
      folderKey(next.flow.session.buildConfig) !== folderKey(previous.flow.session.buildConfig);
    if (!previous.ready || moved) void refresh();
  });
  save.subscribe((next, previous) => {
    if (previous.saving && !next.saving && next.error === null) void refresh();
  });
  void refresh();

  return store;
};
