import { mkdir, rm } from "node:fs/promises";
import type { WorktreeRemoval } from "../../src/core/run/workspace.js";
import type {
  Worktree,
  WorktreeAddOptions,
  WorktreeRemoveOptions,
} from "../../src/ports/worktree.js";

export class FakeWorktree implements Worktree {
  readonly calls: WorktreeAddOptions[] = [];
  readonly removed: WorktreeRemoveOptions[] = [];
  readonly deletedBranches: { repo: string; branch: string }[] = [];

  constructor(
    private readonly options: { failWith?: string; dirty?: string[]; unpushed?: string[] } = {},
  ) {}

  async add(options: WorktreeAddOptions): Promise<void> {
    this.calls.push(options);
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    await mkdir(options.path, { recursive: true });
  }

  async remove(options: WorktreeRemoveOptions): Promise<WorktreeRemoval> {
    this.removed.push(options);
    await rm(options.path, { recursive: true, force: true });
    return { worktree: "removed", branch: "removed" };
  }

  async isDirty(path: string): Promise<boolean> {
    return this.options.dirty?.includes(path) ?? false;
  }

  async hasUnpushed(...[, branch]: Parameters<Worktree["hasUnpushed"]>): Promise<boolean> {
    return this.options.unpushed?.includes(branch) ?? false;
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    this.deletedBranches.push({ repo, branch });
  }
}
