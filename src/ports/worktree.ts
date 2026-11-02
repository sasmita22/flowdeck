import type { WorktreeRemoval } from "../core/run/worktree-cleanup.js";

export type WorktreeAddOptions = { repo: string; base: string; branch: string; path: string };

export type WorktreeRemoveOptions = WorktreeAddOptions;

export interface Worktree {
  add(options: WorktreeAddOptions): Promise<void>;
  remove(options: WorktreeRemoveOptions): Promise<WorktreeRemoval>;
}
