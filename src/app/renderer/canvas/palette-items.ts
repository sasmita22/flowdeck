import type { FlowSummary } from "../../../core/flow/flow-store.js";
import type { NodeType } from "../../../core/flow/schema.js";
import { blueprintKindLabel } from "../library-store.js";
import { nodeLook } from "../nodes/look.js";
import { noteLook } from "../nodes/note-look.js";
import { libraryTestIds, paletteTestId } from "../test-ids.js";
import { nodeDefaults, type CanvasItemType, type FlowContainerKind } from "./store.js";

export { flowContainerItems } from "./store.js";

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

const containerItem = (
  type: FlowContainerKind,
  label: string,
  description: string,
): PaletteItem => ({
  type,
  testId: paletteTestId(type),
  label,
  tag: label.toUpperCase(),
  color: "var(--c-io)",
  group: "Composition",
  description,
});

const containerItems: readonly PaletteItem[] = [
  containerItem(
    "workspace",
    "Workspace",
    "The one place a workflow starts and ends, with its own Start, Stop and model.",
  ),
  containerItem(
    "session",
    "Session",
    "One Claude Code session on a repository and branch, with its own Start, Stop and model.",
  ),
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
  ...containerItems,
  noteItem,
];

export type LibraryKind = "node-library" | "session-library";

export interface LibraryItem {
  flowId: string;
  testId: string;
  label: string;
  kind: LibraryKind;
  kindLabel: string;
}

const isLibraryKind = (kind: FlowSummary["kind"]): kind is LibraryKind =>
  kind === "node-library" || kind === "session-library";

export const libraryItems = (
  summaries: readonly FlowSummary[],
  openFlowId: string | null,
): LibraryItem[] =>
  summaries.flatMap(({ flowId, name, kind }) =>
    isLibraryKind(kind) && flowId !== openFlowId
      ? [
          {
            flowId,
            testId: libraryTestIds.paletteItem(flowId),
            label: name,
            kind,
            kindLabel: blueprintKindLabel[kind],
          },
        ]
      : [],
  );

export const filterLibraries = (
  items: readonly LibraryItem[],
  query: string,
): readonly LibraryItem[] => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) =>
    [item.label, item.kindLabel, "libraries"].some((text) => text.toLowerCase().includes(needle)),
  );
};

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
