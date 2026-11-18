import type { ToolStarts } from "../core/run/tool-start.js";

export interface ToolStartSource {
  onToolStart: ToolStarts["onToolStart"];
}
