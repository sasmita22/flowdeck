import type { BuildReport } from "./build-report.js";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import type { BuildFile, Manifest, ManifestNode } from "./lower.js";
import { descriptionOf } from "./merge.js";
import { orchestratorPath } from "./orchestrator.js";
import { pieceOf } from "./pieces.js";
import { scopeLine, scopeOf } from "./scope-line.js";

export const SHARED_PIECE_TOOL = "Skill";

export type SharedResult = {
  files: BuildFile[];
  manifest: Manifest;
  accepted: BuildReport["shared"];
  rejected: BuildReport["questions"];
};

type Entry = BuildReport["shared"][number];
type Question = BuildReport["questions"][number];

const manifestPath = "manifest.json";

const kebabCase = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const sharedPath = ({ name, kind }: Pick<Entry, "name" | "kind">): string =>
  kind === "skill" ? `plugin/skills/${name}/SKILL.md` : `plugin/commands/${name}.md`;

const piecesOf = (usedBy: readonly string[], byId: ReadonlyMap<string, ManifestNode>): string[] => [
  ...new Set(usedBy.map((id) => pieceOf(byId.get(id) ?? { id }))),
];

const rejection = (
  entry: Entry,
  byId: ReadonlyMap<string, ManifestNode>,
  taken: ReadonlySet<string>,
): Question | undefined => {
  const { name, kind, usedBy } = entry;
  const [first = ""] = usedBy;
  const shared = `Shared ${kind} ${name}`;
  if (!kebabCase.test(name))
    return {
      nodeId: first,
      text: `${shared} does not have a kebab-case name, like repo-conventions.`,
    };
  if (taken.has(name))
    return { nodeId: first, text: `${shared} has a name this build already gives a piece.` };
  const unknown = usedBy.find((id) => !byId.has(id));
  if (unknown !== undefined)
    return {
      nodeId: unknown,
      text: `${shared} names node ${unknown}, which this build does not have.`,
    };
  const notAgent = usedBy.find((id) => byId.get(id)?.type !== "agent");
  if (notAgent !== undefined)
    return { nodeId: notAgent, text: `${shared} names node ${notAgent}, which is not an agent.` };
  if (piecesOf(usedBy, byId).length < 2)
    return { nodeId: first, text: `${shared} names fewer than two agents.` };
  return undefined;
};

const draftOf = (entry: Entry, users: readonly string[], prefix: string, scope: string): string => {
  const frontmatter = [
    `name: ${JSON.stringify(entry.name)}`,
    `description: ${JSON.stringify(`${scope} Shared ${entry.kind} for the agents ${users.join(", ")}.`)}`,
  ].join("\n");
  const body = [
    `@unfilled: the build agents replace this draft with the finished shared ${entry.kind}.`,
    "## Used by",
    users.map((user) => `- ${user}`).join("\n"),
    `Each runs it with the ${SHARED_PIECE_TOOL} tool as ${prefix}:${entry.name}.`,
  ].join("\n\n");
  return `---\n${frontmatter}\n---\n${body}\n`;
};

export const applyShared = (
  laidDown: readonly BuildFile[],
  manifest: Manifest,
  shared: BuildReport["shared"],
): SharedResult => {
  if (shared.length === 0) return { files: [...laidDown], manifest, accepted: [], rejected: [] };
  const byId = new Map(manifest.nodes.map((node) => [node.id, node]));
  const taken = new Set([
    "run",
    ...manifest.nodes.flatMap((node) => (node.file === undefined ? [] : [pieceOf(node)])),
  ]);
  const orchestrator = laidDown.find((file) => file.path === orchestratorPath)?.content ?? "";
  const parts = scopeOf(descriptionOf(orchestrator));
  if (parts === undefined) throw new Error("the laid-down orchestrator has no scope line");
  const prefix = manifest.prefix ?? parts.build;

  const accepted: Entry[] = [];
  const rejected: Question[] = [];
  const drafts: BuildFile[] = [];
  for (const entry of shared) {
    const question = rejection(entry, byId, taken);
    if (question !== undefined) {
      rejected.push(question);
      continue;
    }
    taken.add(entry.name);
    accepted.push(entry);
    const users = piecesOf(entry.usedBy, byId);
    drafts.push({
      path: sharedPath(entry),
      content: draftOf(entry, users, prefix, scopeLine(parts)),
    });
  }
  if (drafts.length === 0) return { files: [...laidDown], manifest, accepted, rejected };

  const withDrafts: Manifest = {
    ...manifest,
    files: {
      ...manifest.files,
      ...Object.fromEntries(drafts.map((draft) => [draft.path, sha256Hex(draft.content)])),
    },
  };
  const files = [
    ...laidDown.filter((file) => file.path !== manifestPath),
    ...drafts,
    { path: manifestPath, content: canonicalJson(withDrafts) },
  ];
  return { files, manifest: withDrafts, accepted, rejected };
};
