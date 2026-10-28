import { parseFlow, type Flow } from "../../src/core/flow/schema.js";

const at = { x: 0, y: 0 };
const withParent = (parent?: string) => (parent === undefined ? {} : { parent });

const node =
  (type: string, defaults: Record<string, unknown>) =>
  (id: string, options: { parent?: string; settings?: Record<string, unknown> } = {}) => ({
    id,
    label: id,
    position: at,
    type,
    settings: { ...defaults, ...options.settings },
    ...withParent(options.parent),
  });

export const trigger = node("trigger", { inputs: [], flags: {} });
export const prompt = node("prompt", { instructions: "Do the work." });
export const script = node("script", { command: "npm" });
export const agent = node("agent", {
  role: "implementer",
  instructions: "Implement the plan.",
  model: "sonnet",
  tools: [],
});
export const gate = node("gate", { shown: "Check the plan", skippable: false });
export const ask = node("ask", { question: "Pick a colour", options: ["red", "blue", "green"] });
export const loop = node("loop", { condition: "done", cap: 3, onCap: "fail" });
export const hardstop = node("hardstop", {
  condition: "tests fail",
  shown: "test report",
  locked: true,
  enabled: true,
});
export const output = node("output", { name: "result", type: "text" });

export const wire = (from: string, fromPort: string, to: string, toPort: string) => ({
  kind: "then",
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

export const thenWire = (from: string, to: string) => wire(from, "out", to, "in");

export const flow = (nodes: unknown[], wires: unknown[]): Flow =>
  parseFlow({
    nodes,
    wires,
    session: {
      name: "main",
      workingFolder: { kind: "worktree", branch: "main" },
      model: "sonnet",
      allowedTools: [],
      permissionMode: "default",
      connectors: [],
    },
  });
