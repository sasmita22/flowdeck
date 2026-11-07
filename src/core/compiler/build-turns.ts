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
): string => {
  const carried = round > 1 ? failures : [];
  const loose = carried.filter((failure) => !pieces.includes(failure.file));
  const blocks = pieces.map((path) =>
    [
      `PIECE ${path}`,
      `KIND ${pieceKind(manifest, path)}`,
      ...repoLines(manifest),
      ...carried.filter((failure) => failure.file === path).map(failureLine),
    ].join("\n"),
  );
  return [
    `Round ${round}. Dispatch ${kit("piece-auditor")} once for each piece below, all calls in one message.`,
    "Each call's prompt is that piece's block, exactly as written.",
    ...(loose.length > 0
      ? ["", "Files outside these pieces that also failed the check:", ...loose.map(failureLine)]
      : []),
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
};

export const auditTurn = (manifest: Manifest): string =>
  [
    `Dispatch ${kit("handoff-auditor")} once${manifest.prefix === undefined ? "" : ` for the build ${manifest.prefix}`}, with this prompt:`,
    "",
    "PIECE workspace",
    ...repoLines(manifest),
    "",
  ].join("\n");
