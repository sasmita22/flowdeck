import type { Flow } from "../../../core/flow/schema.js";

export type Shortcut =
  | "undo"
  | "redo"
  | "save"
  | "selectAll"
  | "copy"
  | "paste"
  | "duplicate"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "rename";

const fieldTags = ["INPUT", "TEXTAREA", "SELECT"];

const editsText = (target: object | null = null) =>
  target !== null &&
  (("isContentEditable" in target && target.isContentEditable === true) ||
    ("tagName" in target &&
      typeof target.tagName === "string" &&
      fieldTags.includes(target.tagName)));

const pressesButton = (target: object | null = null) =>
  target !== null && "tagName" in target && target.tagName === "BUTTON";

const canvasKeys: Record<string, Shortcut> = {
  c: "copy",
  v: "paste",
  d: "duplicate",
  "=": "zoomIn",
  "+": "zoomIn",
  "-": "zoomOut",
  "0": "zoomReset",
};

export const shortcutFor = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey?: boolean;
  shiftKey: boolean;
  target?: object | null;
}): Shortcut | null => {
  const key = event.key.toLowerCase();
  if (key === "a" && (event.metaKey || event.ctrlKey === true)) {
    return editsText(event.target) ? null : "selectAll";
  }
  if (event.key === "Enter" && !event.metaKey && !event.shiftKey && event.ctrlKey !== true) {
    return editsText(event.target) || pressesButton(event.target) ? null : "rename";
  }
  if (!event.metaKey) return null;
  if (key === "s") return event.shiftKey ? null : "save";
  const canvasKey = canvasKeys[key];
  if (canvasKey !== undefined) return editsText(event.target) ? null : canvasKey;
  if (key !== "z" || editsText(event.target)) return null;
  return event.shiftKey ? "redo" : "undo";
};

type ShortcutState = {
  flow: Flow;
  selection: readonly string[];
  clipboard: object | null;
  ready: boolean;
};

const selectsItem = ({ flow, selection }: ShortcutState) =>
  selection.some(
    (id) =>
      flow.nodes.some((node) => node.id === id) ||
      (flow.notes ?? []).some((note) => note.id === id),
  );

export const claimsShortcut = (shortcut: Shortcut, state: ShortcutState): boolean => {
  if (shortcut === "copy" || shortcut === "duplicate") return state.ready && selectsItem(state);
  if (shortcut === "paste") return state.ready && state.clipboard !== null;
  return true;
};
