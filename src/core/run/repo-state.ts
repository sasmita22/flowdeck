import { z } from "zod";

const count = z.number().int().nonnegative();

export const repoStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("read"),
    branch: z.string().nullable(),
    head: z.string(),
    upstream: z.object({ name: z.string(), ahead: count, behind: count }).nullable(),
    staged: count,
    unstaged: count,
    untracked: count,
  }),
  z.object({ kind: z.literal("unreadable") }),
]);
export type RepoState = z.infer<typeof repoStateSchema>;

export const otherRepoSchema = z.object({
  path: z.string(),
  branch: z.string(),
  before: repoStateSchema.optional(),
  after: repoStateSchema.optional(),
});
export type OtherRepo = z.infer<typeof otherRepoSchema>;

export const branchOf = (state: RepoState): string | undefined =>
  state.kind === "read" ? (state.branch ?? `detached ${state.head}`) : undefined;

export const mergeOtherRepos = (
  befores: ReadonlyMap<string, RepoState>,
  after: readonly OtherRepo[],
): OtherRepo[] => {
  const afterOf = new Map(after.map((repo) => [repo.path, repo]));
  return [...new Set([...befores.keys(), ...afterOf.keys()])].sort().map((path) => {
    const entry = afterOf.get(path);
    const before = befores.get(path);
    const branch =
      entry?.branch ?? (before === undefined ? undefined : branchOf(before)) ?? "not recorded";
    return { ...entry, path, branch, ...(before === undefined ? {} : { before }) };
  });
};

export const runRepoStatesSchema = z.object({
  before: repoStateSchema.nullable(),
  after: repoStateSchema.nullable(),
  otherRepos: z.array(otherRepoSchema),
});
export type RunRepoStates = z.infer<typeof runRepoStatesSchema>;

const nameLimit = 80;
const headLimit = 12;
const pathLimit = 100;
const otherBranchLimit = 60;
const otherReposShown = 10;

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

export const repoStateText = (state: RepoState | null): string => {
  if (state === null || state.kind === "unreadable") return "not recorded";
  const where = state.branch === null ? "detached" : `on ${shortened(state.branch, nameLimit)}`;
  const upstream =
    state.upstream === null
      ? "no upstream"
      : `${state.upstream.behind} behind and ${state.upstream.ahead} ahead of ${shortened(state.upstream.name, nameLimit)} as of the last fetch`;
  return `${where} at ${shortened(state.head, headLimit)}, ${upstream}; ${state.staged} staged, ${state.unstaged} unstaged, ${state.untracked} untracked`;
};

const otherRepoText = (repo: OtherRepo) => {
  const named = `${shortened(repo.path, pathLimit)} (${shortened(repo.branch, otherBranchLimit)})`;
  if (repo.before === undefined && repo.after === undefined) return named;
  return `${named}: before ${repoStateText(repo.before ?? null)}; after ${repoStateText(repo.after ?? null)}`;
};

export const otherReposText = (repos: readonly OtherRepo[]): string => {
  const sorted = [...repos].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shown = sorted.slice(0, otherReposShown).map(otherRepoText);
  const rest = sorted.length - shown.length;
  return [...shown, ...(rest > 0 ? [`and ${rest} more`] : [])].join("; ");
};
