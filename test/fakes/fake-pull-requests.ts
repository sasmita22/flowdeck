import type { PullRequestState, PullRequests } from "../../src/ports/pull-requests.js";

export class FakePullRequests implements PullRequests {
  readonly calls: { repo: string; branch: string }[] = [];

  constructor(private readonly states: Record<string, PullRequestState> = {}) {}

  async openOn(repo: string, branch: string): Promise<PullRequestState> {
    this.calls.push({ repo, branch });
    return this.states[branch] ?? "none";
  }
}
