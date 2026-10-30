import type { DisplayStatus } from "../../../core/run/display.js";

const colors: Record<DisplayStatus, string> = {
  waiting: "#9ca3af",
  running: "#3b82f6",
  "needs you": "#ec4899",
  failed: "#ef4444",
  done: "#22c55e",
};

export const statusBadge = (status: DisplayStatus): { label: string; color: string } => ({
  label: status,
  color: colors[status],
});
