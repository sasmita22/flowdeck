export interface GithubTokenSource {
  token(): Promise<string | undefined>;
}
