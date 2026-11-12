import type { GithubTokenSource } from "../../src/ports/github-token.js";

export class FakeGithubTokenSource implements GithubTokenSource {
  constructor(private readonly value: string | undefined) {}

  async token(): Promise<string | undefined> {
    return this.value;
  }
}
