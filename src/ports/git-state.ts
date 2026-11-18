import type { FolderState } from "../core/flow/workspace-info.js";
import type { RepoState } from "../core/run/repo-state.js";

export type { FolderState, RepoState };

export interface GitState {
  read(folder: string): Promise<FolderState>;
  branches(repo: string): Promise<string[]>;
  defaultBranch(repo: string): Promise<string>;
  checkedOutBranches(repo: string): Promise<Record<string, string>>;
  repoState(folder: string): Promise<RepoState>;
  topLevel(path: string): Promise<string | null>;
}
