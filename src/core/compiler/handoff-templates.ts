import { handoffPairs, type HandoffPair } from "../flow/handoff.js";
import type { Node } from "../flow/schema.js";
import type { BuildFile } from "./lower.js";

export const templateMarker = "@template";

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const sections = ["## Purpose", "## Content", "## Open questions"];

const nodeList = (ids: readonly string[]) => ids.map((id) => `NODE ${id}`).join(", ");

const templateOf = (
  file: string,
  folder: string,
  writers: readonly string[],
  readers: readonly string[],
) =>
  [
    `${templateMarker} ${file}: the writing node replaces this template with the real file, \`${file}\` in the run's working folder (\`${folder}/\` in the workspace).`,
    "",
    `Written by: ${nodeList(writers)}`,
    `Read by: ${nodeList(readers)}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");

export const templatePath = (file: string): string => `plugin/templates/${file}`;

export const hasTemplate = (file: string): boolean => file.endsWith(".md");

export function handoffTemplates(
  flow: { nodes: readonly { id: string; settings: Node["settings"] }[] },
  folder: string,
): BuildFile[] {
  const nodeIds = flow.nodes.map((node) => node.id);
  const pairs = handoffPairs(flow.nodes).filter((pair) => hasTemplate(pair.file));
  const ends = (file: string, end: (pair: HandoffPair) => readonly string[]) => {
    const ids = new Set(pairs.filter((pair) => pair.file === file).flatMap(end));
    return nodeIds.filter((id) => ids.has(id));
  };
  return [...new Set(pairs.map((pair) => pair.file))].sort(byName).map((file) => ({
    path: templatePath(file),
    content: templateOf(
      file,
      folder,
      ends(file, (pair) => pair.writers),
      ends(file, (pair) => [pair.reader]),
    ),
  }));
}
