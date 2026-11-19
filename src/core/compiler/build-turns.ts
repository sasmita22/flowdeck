import type { BuildAnswer, BuildReport } from "./build-report.js";
import type { BuildCheckFailure } from "./check-build.js";
import type { Manifest, ManifestContainer } from "./lower.js";
import { containerRoot } from "./pieces.js";

type PieceKind = "agent" | "template" | "workspace" | "shared";

export const auditPiece = "build";

const kit = (name: string) => `flowdeck-build:${name}`;

const insideContainer = (path: string) => path.replace(/^(workspace|sessions\/[^/]+)\//, "");

export const pieceKind = (path: string): PieceKind => {
  const local = insideContainer(path);
  if (local === "CLAUDE.md") return "workspace";
  if (local.startsWith("plugin/templates/")) return "template";
  if (local.startsWith("plugin/skills/") || local.startsWith("plugin/commands/")) return "shared";
  return "agent";
};

export const manifestNodes = (manifest: Manifest) =>
  manifest.containers.flatMap((container) => container.nodes);

export const nodeIdsOf = (manifest: Manifest, path: string): string[] =>
  manifestNodes(manifest).flatMap((node) => (node.file === path ? [node.id] : []));

const containerOf = (manifest: Manifest, path: string): ManifestContainer | undefined =>
  manifest.containers.find((container) => path.startsWith(`${containerRoot(container)}/`));

const answerNodes = ({ nodeId, otherNodeId }: BuildAnswer): string[] =>
  otherNodeId === undefined ? [nodeId] : [nodeId, otherNodeId];

const isAbout = (answer: BuildAnswer, nodeIds: readonly string[]) =>
  answerNodes(answer).some((id) => nodeIds.includes(id));

const answerLines = (answer: BuildAnswer): string[] => [
  `QUESTION ${answerNodes(answer).join(" ")}: ${answer.text}`,
  `ANSWER ${answer.answer}`,
];

const containerLines = (container: ManifestContainer): string[] => [
  `CONTAINER ${container.slug}`,
  ...(container.repo === undefined ? [] : [`REPO ${container.repo}`]),
];

const pieceContainerLines = (manifest: Manifest, path: string): string[] => {
  const container = containerOf(manifest, path);
  return container === undefined ? [] : containerLines(container);
};

const failureLine = (failure: BuildCheckFailure) =>
  `FAILED ${failure.file} ${failure.rule}: ${failure.detail}`;

const sharedLines = (manifest: Manifest, path: string, shared: BuildReport["shared"]): string[] => {
  const nodeIds = nodeIdsOf(manifest, path);
  const prefix = containerOf(manifest, path)?.prefix ?? manifest.prefix ?? "";
  return shared.flatMap(({ name, usedBy }) =>
    usedBy.some((id) => nodeIds.includes(id)) ? [`SHARED ${prefix}:${name}`] : [],
  );
};

export const writeTurn = (
  manifest: Manifest,
  pieces: readonly string[],
  round: number,
  failures: readonly BuildCheckFailure[] = [],
  answers: readonly BuildAnswer[] = [],
  shared: BuildReport["shared"] = [],
): string => {
  const carried = round > 1 ? failures : [];
  const given = round === 1 ? answers : [];
  const loose = carried.filter((failure) => !pieces.includes(failure.file));
  const served = pieces.flatMap((path) => nodeIdsOf(manifest, path));
  const unplaced = given.filter((answer) => !isAbout(answer, served));
  const blocks = pieces.map((path) =>
    [
      `PIECE ${path}`,
      `KIND ${pieceKind(path)}`,
      ...pieceContainerLines(manifest, path),
      ...sharedLines(manifest, path, shared),
      ...carried.filter((failure) => failure.file === path).map(failureLine),
      ...given.filter((answer) => isAbout(answer, nodeIdsOf(manifest, path))).flatMap(answerLines),
    ].join("\n"),
  );
  return [
    `Round ${round}. Dispatch ${kit("piece-auditor")} once for each piece below, all calls in one message.`,
    "Each call's prompt is that piece's block, exactly as written.",
    ...(loose.length > 0
      ? [
          "",
          "Files outside these pieces that also failed the check:",
          "These files belong to no piece in this round: give them to no agent, put them in no block and edit none of them yourself. Dispatch only for the pieces listed in this turn; if none is listed, dispatch nothing.",
          ...loose.map(failureLine),
        ]
      : []),
    ...(unplaced.length > 0
      ? [
          "",
          "Answers about nodes outside these pieces:",
          "No piece in this turn serves these nodes: put these answers in no block and act on none of them yourself; they reach those nodes outside this turn.",
          ...unplaced.flatMap(answerLines),
        ]
      : []),
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
};

const containerParagraphs = (containers: readonly ManifestContainer[]): string[] =>
  containers.flatMap((container) => [
    "",
    ...containerLines(container),
    `FOLDER ${containerRoot(container)}`,
  ]);

export const auditTurn = (manifest: Manifest, answers: readonly BuildAnswer[] = []): string =>
  [
    `Dispatch ${kit("handoff-auditor")} once${manifest.prefix === undefined ? "" : ` for the build ${manifest.prefix}`}, with this prompt:`,
    "",
    `PIECE ${auditPiece}`,
    ...answers.flatMap(answerLines),
    ...containerParagraphs(manifest.containers),
    "",
  ].join("\n");
