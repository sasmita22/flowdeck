export type Shortcut = "undo" | "redo";

export const shortcutFor = (event: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}): Shortcut | null => {
  if (!event.metaKey || event.key.toLowerCase() !== "z") return null;
  return event.shiftKey ? "redo" : "undo";
};
