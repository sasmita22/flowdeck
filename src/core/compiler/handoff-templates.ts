import type { Wire } from "../flow/schema.js";
import type { BuildFile } from "./lower.js";

export const templateMarker = "@template";

type FileWire = Extract<Wire, { kind: "file" }>;

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
    `${templateMarker} ${file}: the writing node replaces this template with the real file, \`${folder}/${file}\` in the run's working folder.`,
    "",
    `Written by: ${nodeList(writers)}`,
    `Read by: ${nodeList(readers)}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");

export const templatePath = (file: string): string => `plugin/templates/${file}`;

export const hasTemplate = (file: string): boolean => file.endsWith(".md");

export function handoffTemplates(
  flow: {
    nodes: readonly { id: string }[];
    wires: readonly Wire[];
  },
  folder: string,
): BuildFile[] {
  const nodeIds = flow.nodes.map((node) => node.id);
  const wires = flow.wires.filter(
    (wire): wire is FileWire => wire.kind === "file" && hasTemplate(wire.file),
  );
  const ends = (file: string, end: (wire: FileWire) => string) => {
    const ids = new Set(wires.filter((wire) => wire.file === file).map(end));
    return nodeIds.filter((id) => ids.has(id));
  };
  return [...new Set(wires.map((wire) => wire.file))].sort(byName).map((file) => ({
    path: templatePath(file),
    content: templateOf(
      file,
      folder,
      ends(file, (wire) => wire.from.node),
      ends(file, (wire) => wire.to.node),
    ),
  }));
}
