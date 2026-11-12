import type { Node } from "./schema.js";

export type Handoff = { given: readonly string[]; writes: readonly string[] };

export type HandoffPair = { file: string; reader: string; writers: string[] };

type HandingNode = { id: string; settings: Node["settings"] };

const once = (files: readonly string[]) => [...new Set(files)];

const line = (lead: string, files: readonly string[]) =>
  files.length === 0 ? [] : [`${lead}: ${files.join(", ")}`];

export const handoffFolderLine = (folder: string): string =>
  `Hand-off files are read and written by bare name (\`<file>\`, not \`${folder}/<file>\`) in the run's working folder. A run starts there; in this build's workspace that folder is \`${folder}/\`. Never use the workspace folder itself.`;

export const declaredHandoff = (settings: Node["settings"]): Handoff => ({
  given: once("given" in settings ? (settings.given ?? []) : []),
  writes: once("writes" in settings ? (settings.writes ?? []) : []),
});

export function handoffPairs(nodes: readonly HandingNode[]): HandoffPair[] {
  return nodes.flatMap((reader) =>
    declaredHandoff(reader.settings).given.flatMap((file) => {
      const writers = nodes
        .filter(
          (node) => node.id !== reader.id && declaredHandoff(node.settings).writes.includes(file),
        )
        .map((node) => node.id);
      return writers.length === 0 ? [] : [{ file, reader: reader.id, writers }];
    }),
  );
}

export function handoffText({ given, writes }: Handoff): string {
  const lines = [...line("You are given", given), ...line("Write", writes)];
  return lines.length === 0 ? "" : `\n${lines.join("\n")}\n`;
}
