export type ScopeParts = {
  build: string;
  repo: string;
  workspace: string;
  kind?: "workspace" | "session";
};

export function scopeLine({ build, repo, workspace }: ScopeParts): string {
  return `Part of build ${build} (repo ${repo}, build folder ${workspace}). For work in this build, use this, not a similarly named skill from elsewhere.`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const scopeParts = new RegExp(
  `^${escapeRegExp(scopeLine({ build: "\0", repo: "\0", workspace: "\0" })).replaceAll("\0", "(.*?)")}`,
);

export function scopeOf(description: string): ScopeParts | undefined {
  const match = scopeParts.exec(description);
  if (match === null) return undefined;
  const [, build = "", repo = "", workspace = ""] = match;
  return { build, repo, workspace };
}
