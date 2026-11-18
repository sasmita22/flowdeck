import type { FolderState, GitState, RepoState } from "../../src/ports/git-state.js";

export class FakeGitState implements GitState {
  readonly reads: string[] = [];
  readonly repoStates = new Map<string, RepoState>();
  readonly tops = new Map<string, string>();
  readonly repoStateCalls: string[] = [];

  constructor(
    private readonly states: Record<string, FolderState> = {},
    private readonly options: {
      failWith?: string;
      branches?: Record<string, string[]>;
      defaultBranches?: Record<string, string>;
      checkedOut?: Record<string, Record<string, string>>;
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

  async checkedOutBranches(repo: string): Promise<Record<string, string>> {
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    return this.options.checkedOut?.[repo] ?? {};
  }

  async repoState(folder: string): Promise<RepoState> {
    this.repoStateCalls.push(folder);
    return this.repoStates.get(folder) ?? { kind: "unreadable" };
  }

  async topLevel(path: string): Promise<string | null> {
    const exact = this.tops.get(path);
    if (exact !== undefined) return exact;
    const holder = [...this.tops.keys()]
      .filter((folder) => path.startsWith(`${folder}/`))
      .sort((a, b) => b.length - a.length)[0];
    return holder === undefined ? null : (this.tops.get(holder) ?? null);
  }
}
