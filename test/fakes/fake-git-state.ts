import type { FolderState, GitState } from "../../src/ports/git-state.js";

export class FakeGitState implements GitState {
  readonly reads: string[] = [];

  constructor(
    private readonly states: Record<string, FolderState> = {},
    private readonly options: {
      failWith?: string;
      branches?: Record<string, string[]>;
      defaultBranches?: Record<string, string>;
    } = {},
  ) {}

  async read(folder: string): Promise<FolderState> {
    this.reads.push(folder);
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    return this.states[folder] ?? { kind: "missing" };
  }

  async branches(repo: string): Promise<string[]> {
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    return this.options.branches?.[repo] ?? [];
  }

  async defaultBranch(repo: string): Promise<string> {
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    return this.options.defaultBranches?.[repo] ?? "main";
  }
}
