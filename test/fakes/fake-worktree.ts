import { mkdir, rm } from "node:fs/promises";
import type { WorktreeRemoval } from "../../src/core/run/workspace.js";
import type {
  Worktree,
  WorktreeAddOptions,
  WorktreeCheckout,
  WorktreeRemoveOptions,
} from "../../src/ports/worktree.js";

export class FakeWorktree implements Worktree {
  readonly calls: WorktreeAddOptions[] = [];
  readonly removed: WorktreeRemoveOptions[] = [];
  readonly deletedBranches: { repo: string; branch: string }[] = [];
  readonly deletedRemoteBranches: { repo: string; branch: string; tip: string }[] = [];
  readonly branches = new Set<string>();
  readonly worktrees = new Map<string, Pick<WorktreeAddOptions, "repo" | "base" | "branch">>();
  private readonly goneBranches = new Set<string>();

  constructor(
    private readonly options: { failWith?: string; dirty?: string[]; unpushed?: string[] } = {},
  ) {}

  async add(options: WorktreeAddOptions): Promise<void> {
    this.calls.push(options);
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    await mkdir(options.path, { recursive: true });
    this.worktrees.set(options.path, {
      repo: options.repo,
      base: options.base,
      branch: options.branch,
    });
    this.branches.add(options.branch);
  }

  async remove(options: WorktreeRemoveOptions): Promise<WorktreeRemoval> {
    this.removed.push(options);
    if (!options.force && (await this.isDirty(options.path))) {
      return { worktree: "kept", branch: "kept" };
    }
    await rm(options.path, { recursive: true, force: true });
    this.worktrees.delete(options.path);
    if (!options.create) return { worktree: "removed", branch: "kept" };
    this.branches.delete(options.branch);
    this.goneBranches.add(options.branch);
    return { worktree: "removed", branch: "removed" };
  }

  async isDirty(path: string): Promise<boolean> {
    return this.options.dirty?.includes(path) ?? false;
  }

  async hasUnpushed(...[repo, branch]: Parameters<Worktree["hasUnpushed"]>): Promise<boolean> {
    const remoteGone = this.deletedRemoteBranches.some(
      (deleted) => deleted.repo === repo && deleted.branch === branch,
    );
    return remoteGone || (this.options.unpushed?.includes(branch) ?? false);
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    this.deletedBranches.push({ repo, branch });
    this.goneBranches.add(branch);
  }

  async branchTip(_repo: string, branch: string): Promise<string | undefined> {
    return this.goneBranches.has(branch) ? undefined : `tip-of-${branch}`;
  }

  async deleteRemoteBranch(repo: string, branch: string, tip: string): Promise<string[]> {
    this.deletedRemoteBranches.push({ repo, branch, tip });
    return [];
  }

  async checkoutAt(path: string): Promise<WorktreeCheckout | undefined> {
    const held = this.worktrees.get(path);
    return held === undefined ? undefined : { path, repo: held.repo, branch: held.branch };
  }
}
