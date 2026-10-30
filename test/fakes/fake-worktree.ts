import { mkdir } from "node:fs/promises";
import type { Worktree, WorktreeAddOptions } from "../../src/ports/worktree.js";

export class FakeWorktree implements Worktree {
  readonly calls: WorktreeAddOptions[] = [];

  constructor(private readonly options: { failWith?: string } = {}) {}

  async add(options: WorktreeAddOptions): Promise<void> {
    this.calls.push(options);
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    await mkdir(options.path, { recursive: true });
  }
}
