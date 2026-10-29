export type Shortcut = "undo" | "redo" | "save";

export const shortcutFor = (event: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}): Shortcut | null => {
  if (!event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === "s") return event.shiftKey ? null : "save";
  if (key !== "z") return null;
  return event.shiftKey ? "redo" : "undo";
};
