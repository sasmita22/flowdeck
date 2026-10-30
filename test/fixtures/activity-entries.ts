import type { ActivityEntry } from "../../src/core/run/activity.js";

export const tool = (id: number): ActivityEntry => ({
  id,
  nodeId: "p1",
  at: 1000 + id,
  kind: "tool",
  tool: "Bash",
  summary: "ls",
});

export const subagent = (id: number, state: "running" | "finished"): ActivityEntry => ({
  id,
  nodeId: "p1",
  at: 1000 + id,
  kind: "subagent",
  agentType: "general-purpose",
  summary: "Run a1",
  state,
});
