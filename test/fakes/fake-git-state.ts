import type { FolderState, GitState } from "../../src/ports/git-state.js";

export class FakeGitState implements GitState {
  readonly reads: string[] = [];

  constructor(
    private readonly states: Record<string, FolderState> = {},
    private readonly options: { failWith?: string } = {},
  ) {}

  async read(folder: string): Promise<FolderState> {
    this.reads.push(folder);
    if (this.options.failWith !== undefined) throw new Error(this.options.failWith);
    return this.states[folder] ?? { kind: "missing" };
  }
}
