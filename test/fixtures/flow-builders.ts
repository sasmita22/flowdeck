import { parseFlow, type Flow, type SessionContainer } from "../../src/core/flow/schema.js";

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
export const branch = (id: string, variable: string, options: { parent?: string } = {}) =>
  node("branch", { variable })(id, options);
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

export const flowSettings = { buildModel: "sonnet", permissionMode: "default" };

type SessionOptions = {
  id?: string;
  name?: string;
  repo?: string;
  branch?: string;
  model?: string;
};

export const workspaceContainer = (
  nodes: string[],
  options: { id?: string; model?: string } = {},
) => ({ id: "workspace-1", kind: "workspace", model: "sonnet", ...options, nodes });

export const sessionContainer = (nodes: string[], options: SessionOptions = {}) => ({
  id: "session-1",
  kind: "session",
  name: "main",
  repo: "/work/repo",
  branch: "main",
  model: "sonnet",
  ...options,
  nodes,
});

export const withSession = (
  flow: Flow,
  patch: Partial<Pick<SessionContainer, "name" | "repo" | "branch" | "model">>,
): Flow => ({
  ...flow,
  containers: flow.containers.map((container) =>
    container.kind === "session" ? { ...container, ...patch } : container,
  ),
});

const workspaceStart = "workspace-1-start";
const workspaceStop = "workspace-1-stop";

const topLevelIds = (nodes: unknown[]) =>
  (nodes as { id: string; parent?: string }[])
    .filter((node) => node.parent === undefined)
    .map((node) => node.id);

export const inOneSession = (nodes: unknown[], wires: unknown[]): Flow =>
  parseFlow({
    nodes,
    wires,
    settings: flowSettings,
    containers: [sessionContainer(topLevelIds(nodes))],
  });

export const flow = (
  nodes: unknown[],
  wires: unknown[],
  settings: Record<string, unknown> = flowSettings,
  options: { session?: Omit<SessionOptions, "id">; containers?: unknown[] } = {},
): Flow => {
  if (options.containers !== undefined) {
    return parseFlow({ nodes, wires, settings, containers: options.containers });
  }
  const topLevel = topLevelIds(nodes);
  return parseFlow({
    nodes: [...nodes, trigger(workspaceStart), output(workspaceStop)],
    wires: [...wires, thenWire(workspaceStart, workspaceStop)],
    settings,
    containers: [
      workspaceContainer([workspaceStart, workspaceStop]),
      sessionContainer(topLevel, options.session),
    ],
  });
};

export const bareFlow = (nodes: unknown[] = [], wires: unknown[] = []): Flow =>
  flow(nodes, wires, flowSettings, { containers: [] });

export const asWorkflow = (
  literal: { nodes: unknown[]; wires: unknown[]; settings: Record<string, unknown> },
  session: Omit<SessionOptions, "id"> = {},
): Flow => flow(literal.nodes, literal.wires, literal.settings, { session });

export type SessionSpec = {
  name: string;
  repo: string;
  branch: string;
  model?: string;
  members?: string[];
};

const memberId = (containerId: string, label: string) =>
  `${containerId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

const containerChain = (containerId: string, members: string[]) => {
  const start = `${containerId}-start`;
  const stop = `${containerId}-stop`;
  const agents = members.map((label) => ({ ...agent(memberId(containerId, label)), label }));
  const ids = [start, ...agents.map((node) => node.id), stop];
  return {
    ids,
    nodes: [trigger(start), ...agents, output(stop)],
    wires: ids.slice(1).map((id, index) => thenWire(ids[index] as string, id)),
  };
};

export const sessionsWorkflow = (
  sessions: SessionSpec[],
  options: { workspace?: string[] } = {},
): Flow => {
  const workspace = containerChain("workspace-1", options.workspace ?? []);
  const chains = sessions.map(({ members = ["Plan"], ...session }, index) => {
    const id = `session-${index + 1}`;
    const chain = containerChain(id, members);
    return {
      chain,
      container: sessionContainer(chain.ids, { model: "sonnet", ...session, id }),
    };
  });
  return parseFlow({
    nodes: [...workspace.nodes, ...chains.flatMap(({ chain }) => chain.nodes)],
    wires: [...workspace.wires, ...chains.flatMap(({ chain }) => chain.wires)],
    settings: flowSettings,
    containers: [workspaceContainer(workspace.ids), ...chains.map(({ container }) => container)],
  });
};

export const twoSessionWorkflow = (): Flow =>
  sessionsWorkflow([
    { name: "android", repo: "/repos/android", branch: "main", model: "sonnet" },
    { name: "ios", repo: "/repos/ios", branch: "develop", model: "haiku" },
  ]);

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
