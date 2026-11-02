import type { FolderState } from "../core/flow/workspace-info.js";

export type { FolderState };

export interface GitState {
  read(folder: string): Promise<FolderState>;
  branches(repo: string): Promise<string[]>;
}
