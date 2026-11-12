import { execFile } from "node:child_process";
import type { GithubTokenSource } from "../../ports/github-token.js";

export class GhTokenSource implements GithubTokenSource {
  private readonly command: string;

  constructor(options: { command?: string } = {}) {
    this.command = options.command ?? "gh";
  }

  token(): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile(this.command, ["auth", "token"], (error, stdout) => {
        const token = error === null ? stdout.trim() : "";
        resolve(token === "" ? undefined : token);
      });
    });
  }
}
