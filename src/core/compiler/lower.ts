import { order } from "../flow/order.js";
import type { Flow, Node, Session, Wire } from "../flow/schema.js";
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
  inputs?: string[];
  outputs?: ManifestOutput[];
  session: Omit<Session, "frame">;
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
  Required<Pick<Manifest, "prefix" | "layout" | "values">>;

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

export function lower(
  flow: Flow,
  inputs: LowerInputs,
  source?: BuildSource,
): { manifest: LoweredManifest; nodeFiles: BuildFile[] } {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const nodes = order(flow).flatMap((id) => byId.get(id) ?? []);
  const pieces = pieceNames(flow);
  const compiled = nodes.map((node) => {
    const piece = pieces.get(node.id);
    return { node, piece, file: compile(node, piece, inputs) };
  });
  const session = { ...flow.session };
  delete session.frame;
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
      session,
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
