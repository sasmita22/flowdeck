import type { WorktreeRemoval } from "../core/run/workspace.js";

export type WorktreeAddOptions = { repo: string; base: string; branch: string; path: string };

export type WorktreeRemoveOptions = WorktreeAddOptions;

export interface Worktree {
  add(options: WorktreeAddOptions): Promise<void>;
  remove(options: WorktreeRemoveOptions): Promise<WorktreeRemoval>;
  isDirty(path: string): Promise<boolean>;
  hasUnpushed(repo: string, branch: string, base: string): Promise<boolean>;
  deleteBranch(repo: string, branch: string): Promise<void>;
}
