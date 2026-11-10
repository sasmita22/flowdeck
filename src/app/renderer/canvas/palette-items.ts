import type { NodeType } from "../../../core/flow/schema.js";
import { nodeLook } from "../nodes/look.js";
import { noteLook } from "../nodes/note-look.js";
import { paletteTestId } from "../test-ids.js";
import { nodeDefaults, type CanvasItemType } from "./store.js";

export const paletteGroups = [
  "",
  "Composition",
  "Work",
  "Control",
  "People and safety",
  "Run events",
  "Canvas",
] as const;

export type PaletteGroup = (typeof paletteGroups)[number];

export interface PaletteItem {
  type: CanvasItemType;
  testId: string;
  label: string;
  tag: string;
  color: string;
  group: PaletteGroup;
  description: string;
}

const catalog: [NodeType, PaletteGroup, string][] = [
  ["trigger", "", "Where the blueprint starts. Everything wired from here is the main flow."],
  ["output", "", "Where the main flow ends, and what it hands back."],
  [
    "agent",
    "Work",
    "A subagent with a fresh, isolated context. Hands back one finding or one file.",
  ],
  ["fork", "Control", "Splits into branches that run at the same time."],
  ["join", "Control", "Waits for the branches before continuing."],
  ["loop", "Control", "Repeats its body until a condition holds, with a cap."],
  ["foreach", "Control", "Runs its body once per item in a list."],
  ["branch", "Control", "Takes one path or the other, set by a yes/no variable."],
  ["gate", "People and safety", "Pauses until you approve. A flag can switch it off."],
  [
    "hardstop",
    "People and safety",
    "Stops the session and asks you when a condition is met. Nothing can switch it off.",
  ],
  ["ask", "People and safety", "Puts a question to you in the app and waits for the answer."],
];

const noteItem: PaletteItem = {
  type: "note",
  testId: paletteTestId("note"),
  label: "Note",
  tag: "NOTE",
  color: noteLook.tag,
  group: "Canvas",
  description: "Canvas-only text. It never runs.",
};

export const paletteItems: readonly PaletteItem[] = [
  ...catalog.map(([type, group, description]) => ({
    type,
    testId: paletteTestId(type),
    label: nodeDefaults[type].label,
    tag: nodeLook(type).tag,
    color: nodeLook(type).group,
    group,
    description,
  })),
  noteItem,
];

export const filterPalette = (
  items: readonly PaletteItem[],
  query: string,
): readonly PaletteItem[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle),
  );
};

export const groupPalette = (items: readonly PaletteItem[]) =>
  paletteGroups
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter(({ items: grouped }) => grouped.length > 0);

const titles = new Map(
  paletteItems.map(({ type, label, description }) => [type, `${label}: ${description}`]),
);

export const nodeTitle = (type: NodeType): string => titles.get(type) ?? "";

export const noteTitle = "Note: canvas-only text. It never runs.";
