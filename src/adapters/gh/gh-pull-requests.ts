import { execFile } from "node:child_process";
import type { PullRequestState, PullRequests } from "../../ports/pull-requests.js";

function stateOf(stdout: string): PullRequestState {
  try {
    const listed: unknown = JSON.parse(stdout);
    if (!Array.isArray(listed)) return "unknown";
    return listed.length > 0 ? "open" : "none";
  } catch {
    return "unknown";
  }
}

export class GhPullRequests implements PullRequests {
  private readonly command: string;

  constructor(options: { command?: string } = {}) {
    this.command = options.command ?? "gh";
  }

  openOn(repo: string, branch: string): Promise<PullRequestState> {
    const args = ["pr", "list", "--head", branch, "--state", "open", "--json", "number"];
    return new Promise((resolve) => {
      execFile(this.command, args, { cwd: repo }, (error, stdout) => {
        resolve(error === null ? stateOf(stdout) : "unknown");
      });
    });
  }
}
