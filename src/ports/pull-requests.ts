export type PullRequestState = "open" | "none" | "unknown";

export interface PullRequests {
  openOn(repo: string, branch: string): Promise<PullRequestState>;
}
