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
export const forEach = (
  id: string,
  settings: Record<string, unknown> = { file: "plan.md" },
  label = "each plan unit",
) => ({ id, label, position: at, type: "foreach", settings });
export const branch = (id: string, flag: string, options: { parent?: string } = {}) =>
  node("branch", { flag })(id, options);
export const fork = node("fork", {});
export const join = node("join", { wait: "all" });

export const wire = (from: string, fromPort: string, to: string, toPort: string) => ({
  kind: "then",
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

export const thenWire = (from: string, to: string) => wire(from, "out", to, "in");

export const fileWire = (from: string, to: string, file: string) => ({
  kind: "file",
  from: { node: from, port: "file-out" },
  to: { node: to, port: "file-in" },
  file,
});

export const flow = (nodes: unknown[], wires: unknown[]): Flow =>
  parseFlow({
    nodes,
    wires,
    session: {
      name: "main",
      buildConfig: { repo: "/work/repo", base: "main", variables: [] },
      model: "sonnet",
      allowedTools: [],
      permissionMode: "default",
      connectors: [],
    },
  });

type Placed = { id: string; type: string; parent?: string };
type Linked = { kind: string; from: { node: string }; to: { node: string } };

export const onMainFlow = (nodes: unknown[], wires: unknown[]): Flow => {
  const placed = nodes as Placed[];
  const clash = placed.find(
    (node) =>
      node.id === "start" ||
      node.id === "stop" ||
      node.type === "trigger" ||
      node.type === "output",
  );
  if (clash !== undefined) throw new Error(`onMainFlow adds Start and Stop itself: ${clash.id}`);

  const parentOf = new Map(placed.map((node) => [node.id, node.parent]));
  const topOf = (id: string): string => {
    const parent = parentOf.get(id);
    return parent === undefined ? id : topOf(parent);
  };
  const crossing = (wires as Linked[])
    .filter((wire) => wire.kind === "then")
    .map((wire) => ({ from: topOf(wire.from.node), to: topOf(wire.to.node) }))
    .filter((wire) => wire.from !== wire.to);

  const tops = placed.filter((node) => node.parent === undefined).map((node) => node.id);
  const entries = tops.filter((id) => !crossing.some((wire) => wire.to === id));
  const exits = tops.filter((id) => !crossing.some((wire) => wire.from === id));

  return flow(
    [trigger("start"), ...nodes, output("stop")],
    [
      ...entries.map((id) => thenWire("start", id)),
      ...wires,
      ...exits.map((id) => thenWire(id, "stop")),
    ],
  );
};
