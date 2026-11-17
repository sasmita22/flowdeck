import type { WorktreeRemoval } from "../core/run/workspace.js";

export type WorktreeAddOptions = {
  repo: string;
  base: string;
  branch: string;
  path: string;
  create: boolean;
};

export type WorktreeRemoveOptions = WorktreeAddOptions & { force?: boolean };

export interface Worktree {
  add(options: WorktreeAddOptions): Promise<void>;
  remove(options: WorktreeRemoveOptions): Promise<WorktreeRemoval>;
  isDirty(path: string): Promise<boolean>;
  hasUnpushed(repo: string, branch: string, base: string): Promise<boolean>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  branchTip(repo: string, branch: string): Promise<string | undefined>;
  deleteRemoteBranch(repo: string, branch: string, tip: string): Promise<string[]>;
}
