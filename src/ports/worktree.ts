export type WorktreeAddOptions = { repo: string; base: string; branch: string; path: string };

export interface Worktree {
  add(options: WorktreeAddOptions): Promise<void>;
}
