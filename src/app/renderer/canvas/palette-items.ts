import type { NodeType } from "../../../core/flow/schema.js";
import { nodeLook } from "../nodes/look.js";
import { paletteTestId } from "../test-ids.js";
import { nodeDefaults } from "./store.js";

export const paletteGroups = [
  "Composition",
  "Work",
  "Control",
  "People and safety",
  "Run events",
  "In and out",
] as const;

export type PaletteGroup = (typeof paletteGroups)[number];

export interface PaletteItem {
  type: NodeType;
  testId: string;
  label: string;
  tag: string;
  color: string;
  group: PaletteGroup;
  description: string;
}

const catalog: [NodeType, PaletteGroup, string][] = [
  [
    "agent",
    "Work",
    "A subagent with a fresh, isolated context. Hands back one finding or one file.",
  ],
  [
    "prompt",
    "Work",
    "One turn inside the session's own context: the session sees everything that came before.",
  ],
  [
    "script",
    "Work",
    "A shell command the app runs itself. No model involved, so it always behaves the same.",
  ],
  ["fork", "Control", "Splits into branches that run at the same time."],
  ["join", "Control", "Waits for the branches before continuing."],
  ["loop", "Control", "Repeats its body until a condition holds, with a cap."],
  ["foreach", "Control", "Runs its body once per item in a list."],
  ["branch", "Control", "Routes one way or another on a flag or a verdict."],
  ["gate", "People and safety", "Pauses until you approve. A flag can switch it off."],
  [
    "hardstop",
    "People and safety",
    "Stops the session and asks you when a condition is met. Nothing can switch it off.",
  ],
  ["ask", "People and safety", "Puts a question to you in the app and waits for the answer."],
  ["trigger", "In and out", "Where a flow starts: the Run button, with its inputs."],
  ["output", "In and out", "What the flow hands back to whoever used it."],
];

export const paletteItems: readonly PaletteItem[] = catalog.map(([type, group, description]) => ({
  type,
  testId: paletteTestId(type),
  label: nodeDefaults[type].label,
  tag: nodeLook(type).tag,
  color: nodeLook(type).group,
  group,
  description,
}));

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
