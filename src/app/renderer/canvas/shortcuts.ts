export type Shortcut = "undo" | "redo" | "save" | "selectAll";

const fieldTags = ["INPUT", "TEXTAREA", "SELECT"];

const editsText = (target: object | null = null) =>
  target !== null &&
  (("isContentEditable" in target && target.isContentEditable === true) ||
    ("tagName" in target &&
      typeof target.tagName === "string" &&
      fieldTags.includes(target.tagName)));

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
  if (!event.metaKey) return null;
  if (key === "s") return event.shiftKey ? null : "save";
  if (key !== "z" || editsText(event.target)) return null;
  return event.shiftKey ? "redo" : "undo";
};
