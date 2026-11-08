import type { BuildAnswer } from "./build-report.js";
import type { BuildCheckFailure } from "./check-build.js";
import type { Manifest } from "./lower.js";

type PieceKind = "agent" | "step" | "template" | "script" | "workspace";

const kit = (name: string) => `flowdeck-build:${name}`;

export const pieceKind = (manifest: Manifest, path: string): PieceKind => {
  if (path.startsWith("script:")) return "script";
  if (path === "CLAUDE.md") return "workspace";
  if (path.startsWith("plugin/templates/")) return "template";
  const node = manifest.nodes.find((candidate) => candidate.file === path);
  return node?.type === "agent" ? "agent" : "step";
};

export const nodeIdsOf = (manifest: Manifest, path: string): string[] =>
  path.startsWith("script:")
    ? [path.slice("script:".length)]
    : manifest.nodes.flatMap((node) => (node.file === path ? [node.id] : []));

const answerNodes = ({ nodeId, otherNodeId }: BuildAnswer): string[] =>
  otherNodeId === undefined ? [nodeId] : [nodeId, otherNodeId];

const isAbout = (answer: BuildAnswer, nodeIds: readonly string[]) =>
  answerNodes(answer).some((id) => nodeIds.includes(id));

const answerLines = (answer: BuildAnswer): string[] => [
  `QUESTION ${answerNodes(answer).join(" ")}: ${answer.text}`,
  `ANSWER ${answer.answer}`,
];

const repoLines = (manifest: Manifest): string[] => {
  const repo = manifest.session.buildConfig?.repo;
  return repo === undefined ? [] : [`REPO ${repo}`];
};

const failureLine = (failure: BuildCheckFailure) =>
  `FAILED ${failure.file} ${failure.rule}: ${failure.detail}`;

export const writeTurn = (
  manifest: Manifest,
  pieces: readonly string[],
  round: number,
  failures: readonly BuildCheckFailure[] = [],
  answers: readonly BuildAnswer[] = [],
): string => {
  const carried = round > 1 ? failures : [];
  const given = round === 1 ? answers : [];
  const loose = carried.filter((failure) => !pieces.includes(failure.file));
  const served = pieces.flatMap((path) => nodeIdsOf(manifest, path));
  const unplaced = given.filter((answer) => !isAbout(answer, served));
  const blocks = pieces.map((path) =>
    [
      `PIECE ${path}`,
      `KIND ${pieceKind(manifest, path)}`,
      ...repoLines(manifest),
      ...carried.filter((failure) => failure.file === path).map(failureLine),
      ...given.filter((answer) => isAbout(answer, nodeIdsOf(manifest, path))).flatMap(answerLines),
    ].join("\n"),
  );
  return [
    `Round ${round}. Dispatch ${kit("piece-auditor")} once for each piece below, all calls in one message.`,
    "Each call's prompt is that piece's block, exactly as written.",
    ...(loose.length > 0
      ? ["", "Files outside these pieces that also failed the check:", ...loose.map(failureLine)]
      : []),
    ...(unplaced.length > 0
      ? ["", "Answers about nodes outside these pieces:", ...unplaced.flatMap(answerLines)]
      : []),
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
};

export const auditTurn = (manifest: Manifest, answers: readonly BuildAnswer[] = []): string =>
  [
    `Dispatch ${kit("handoff-auditor")} once${manifest.prefix === undefined ? "" : ` for the build ${manifest.prefix}`}, with this prompt:`,
    "",
    "PIECE workspace",
    ...repoLines(manifest),
    ...answers.flatMap(answerLines),
    "",
  ].join("\n");
