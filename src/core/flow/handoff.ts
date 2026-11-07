import type { Wire } from "./schema.js";

export type Handoff = { given: readonly string[]; writes: readonly string[] };

const once = (files: readonly string[]) => [...new Set(files)];

const line = (lead: string, files: readonly string[]) =>
  files.length === 0 ? [] : [`${lead}: ${files.join(", ")}`];

export const handoffFolderLine = (folder: string): string =>
  `Hand-off files are read and written in \`${folder}/\`, the run's working folder inside this build's workspace, never in the workspace folder itself.`;

export function handoffText({ given, writes }: Handoff): string {
  const lines = [...line("You are given", given), ...line("Write", writes)];
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
}

export function withWired(declared: Handoff, wired: Handoff): Handoff {
  return {
    given: once([...declared.given, ...wired.given]),
    writes: once([...declared.writes, ...wired.writes]),
  };
}

export function handoffOf(nodeId: string, wires: readonly Wire[]): Handoff {
  const files = wires.flatMap((wire) => (wire.kind === "file" ? [wire] : []));
  return {
    given: once(files.filter((wire) => wire.to.node === nodeId).map((wire) => wire.file)),
    writes: once(files.filter((wire) => wire.from.node === nodeId).map((wire) => wire.file)),
  };
}
