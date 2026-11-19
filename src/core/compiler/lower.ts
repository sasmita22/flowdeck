import { order } from "../flow/order.js";
import type { Flow, FlowContainer, FlowSettings, Node, Session, Wire } from "../flow/schema.js";
import { flowContainerMembers } from "../flow/structure.js";
import type { VariableValues } from "../flow/variables.js";
import type { BuildSource } from "../run/store.js";
import { compileAgent } from "../nodes/agent/compile.js";
import { repoFolder } from "../run/workspace.js";
import { orchestratorPath } from "./orchestrator.js";
import { containerPrefix, containerRoot, containerSlugs, pieceNames } from "./pieces.js";

export type BuildFile = { path: string; content: string };

export type ManifestNode = {
  id: string;
  type: Node["type"];
  label: string;
  parent?: string;
  settings: Node["settings"];
  file?: string;
  piece?: string;
};

export type ManifestOutput = { node: string; name: string; type: string };

export type ManifestContainer = {
  kind: "workspace" | "session";
  name: string;
  slug: string;
  prefix: string;
  repo?: string;
  base?: string;
  branch?: string;
  worktree?: string;
  model: string;
  nodes: ManifestNode[];
  wires: Wire[];
  orchestrator: string;
};

export type Manifest = {
  version: 1;
  prefix?: string;
  kitVersion?: string;
  layout?: "workspace";
  values?: VariableValues;
  source?: BuildSource;
  outputs?: ManifestOutput[];
  session?: Session;
  settings?: FlowSettings;
  nodes?: ManifestNode[];
  wires?: Wire[];
  containers: ManifestContainer[];
  files: Record<string, string>;
};

export type LowerInputs = {
  name: string;
  values: VariableValues;
  workspace?: string;
  kitVersion?: string;
};

export type LoweredManifest = Omit<Manifest, "files"> &
  Required<Pick<Manifest, "layout" | "values" | "settings">>;

const compile = (
  node: Node,
  piece: string | undefined,
  scope: { build: string; repo: string; workspace: string },
  values: VariableValues,
): BuildFile | undefined => {
  if (piece === undefined) return undefined;
  switch (node.type) {
    case "agent":
      return compileAgent(node, { piece, scope, values });
    default:
      return undefined;
  }
};

const declaredOutputs = (nodes: readonly Node[]): ManifestOutput[] =>
  nodes.flatMap((node) =>
    node.type === "output"
      ? [{ node: node.id, name: node.settings.name, type: node.settings.type }]
      : [],
  );

const containerPart = (flow: Flow, container: FlowContainer): Flow => {
  const members = new Set(flowContainerMembers(flow, container.id));
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => members.has(node.id)),
    wires: flow.wires.filter((wire) => members.has(wire.from.node) && members.has(wire.to.node)),
  };
};

type Lowered = { container: ManifestContainer; files: BuildFile[]; outputs: ManifestOutput[] };

const lowerContainer = (
  whole: Flow,
  container: FlowContainer,
  slug: string,
  inputs: LowerInputs,
): Lowered => {
  const part = containerPart(whole, container);
  const byId = new Map(part.nodes.map((node) => [node.id, node]));
  const nodes = order(part).flatMap((id) => byId.get(id) ?? []);
  const pieces = pieceNames(part);
  const prefix = containerPrefix(inputs.name, slug);
  const root = containerRoot({ kind: container.kind, slug });
  const folder = container.kind === "session" ? repoFolder(container.repo) : root;
  const scope = {
    build: prefix,
    repo: folder,
    workspace: inputs.workspace ?? "",
    kind: container.kind,
  };
  const compiled = nodes.map((node) => {
    const piece = pieces.get(node.id);
    const file = compile(node, piece, scope, inputs.values);
    return { node, piece, file: file && { ...file, path: `${root}/${file.path}` } };
  });
  return {
    container: {
      kind: container.kind,
      name: container.kind === "session" ? container.name : "workspace",
      slug,
      prefix,
      ...(container.kind === "session" ? { repo: container.repo, base: container.branch } : {}),
      model: container.model,
      nodes: compiled.map(({ node, piece, file }) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        ...(node.parent === undefined ? {} : { parent: node.parent }),
        settings: node.settings,
        ...(file === undefined ? {} : { file: file.path }),
        ...(piece === undefined ? {} : { piece }),
      })),
      wires: part.wires,
      orchestrator: orchestratorPath(root),
    },
    files: compiled.flatMap(({ file }) => file ?? []),
    outputs: declaredOutputs(nodes),
  };
};

const singleSessionFields = (lowered: readonly Lowered[]) => {
  const sessions = lowered.filter(({ container }) => container.kind === "session");
  const [single] = sessions;
  if (sessions.length !== 1 || single === undefined) return {};
  const { container: only } = single;
  return {
    prefix: only.prefix,
    session: {
      name: only.name,
      buildConfig: { repo: only.repo, base: only.base },
      model: only.model,
    },
    nodes: only.nodes,
    wires: only.wires,
  };
};

export function lower(
  flow: Flow,
  inputs: LowerInputs,
  source?: BuildSource,
): { manifest: LoweredManifest; nodeFiles: BuildFile[] } {
  const slugs = containerSlugs(flow);
  const lowered = flow.containers.map((container) =>
    lowerContainer(flow, container, slugs.get(container.id) ?? container.kind, inputs),
  );
  const outputs = lowered.flatMap((part) => part.outputs);
  return {
    manifest: {
      version: 1,
      ...(inputs.kitVersion === undefined ? {} : { kitVersion: inputs.kitVersion }),
      layout: "workspace",
      values: inputs.values,
      ...(source === undefined ? {} : { source }),
      ...singleSessionFields(lowered),
      ...(outputs.length === 0 ? {} : { outputs }),
      settings: flow.settings,
      containers: lowered.map(({ container }) => container),
    },
    nodeFiles: lowered.flatMap(({ files }) => files),
  };
}
