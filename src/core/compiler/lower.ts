import { order } from "../flow/order.js";
import type { Flow, FlowSettings, Node, Session, SessionContainer, Wire } from "../flow/schema.js";
import { flowContainerMembers } from "../flow/structure.js";
import type { VariableValues } from "../flow/variables.js";
import type { BuildSource } from "../run/store.js";
import { compileAgent } from "../nodes/agent/compile.js";
import { repoFolder } from "../run/workspace.js";
import { pieceNames } from "./pieces.js";

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

export type Manifest = {
  version: 1;
  prefix?: string;
  kitVersion?: string;
  layout?: "workspace";
  values?: VariableValues;
  source?: BuildSource;
  outputs?: ManifestOutput[];
  session: Session;
  settings?: FlowSettings;
  nodes: ManifestNode[];
  wires: Wire[];
  files: Record<string, string>;
};

export type LowerInputs = {
  name: string;
  values: VariableValues;
  repo?: string;
  workspace?: string;
  kitVersion?: string;
};

export type LoweredManifest = Omit<Manifest, "files"> &
  Required<Pick<Manifest, "prefix" | "layout" | "values" | "settings">>;

const compile = (
  node: Node,
  piece: string | undefined,
  inputs: LowerInputs,
): BuildFile | undefined => {
  if (piece === undefined) return undefined;
  const compileInputs = {
    piece,
    scope: {
      build: inputs.name,
      repo: repoFolder(inputs.repo ?? ""),
      workspace: inputs.workspace ?? "",
    },
    values: inputs.values,
  };
  switch (node.type) {
    case "agent":
      return compileAgent(node, compileInputs);
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

const sessionOf = (flow: Flow): SessionContainer => {
  const session = flow.containers.find(
    (container): container is SessionContainer => container.kind === "session",
  );
  if (session === undefined) throw new Error("A build needs a session container.");
  return session;
};

const sessionPart = (flow: Flow, session: SessionContainer): Flow => {
  const members = new Set(flowContainerMembers(flow, session.id));
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => members.has(node.id)),
    wires: flow.wires.filter((wire) => members.has(wire.from.node) && members.has(wire.to.node)),
  };
};

export function lower(
  whole: Flow,
  inputs: LowerInputs,
  source?: BuildSource,
): { manifest: LoweredManifest; nodeFiles: BuildFile[] } {
  const session = sessionOf(whole);
  const flow = sessionPart(whole, session);
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const nodes = order(flow).flatMap((id) => byId.get(id) ?? []);
  const pieces = pieceNames(flow);
  const compiled = nodes.map((node) => {
    const piece = pieces.get(node.id);
    return { node, piece, file: compile(node, piece, inputs) };
  });
  const outputs = declaredOutputs(nodes);
  return {
    manifest: {
      version: 1,
      prefix: inputs.name,
      ...(inputs.kitVersion === undefined ? {} : { kitVersion: inputs.kitVersion }),
      layout: "workspace",
      values: inputs.values,
      ...(source === undefined ? {} : { source }),
      ...(outputs.length === 0 ? {} : { outputs }),
      session: {
        name: session.name,
        buildConfig: { repo: session.repo, base: session.branch },
        model: session.model,
      },
      settings: flow.settings,
      nodes: compiled.map(({ node, piece, file }) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        ...(node.parent === undefined ? {} : { parent: node.parent }),
        settings: node.settings,
        ...(file === undefined ? {} : { file: file.path }),
        ...(piece === undefined ? {} : { piece }),
      })),
      wires: flow.wires,
    },
    nodeFiles: compiled.flatMap(({ file }) => file ?? []),
  };
}
