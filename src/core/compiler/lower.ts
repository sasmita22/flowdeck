import { handoffOf } from "../flow/handoff.js";
import { order } from "../flow/order.js";
import type { Flow, Node, Session, Wire } from "../flow/schema.js";
import type { BuildSource } from "../run/store.js";
import { compileAgent } from "../nodes/agent/compile.js";
import { compilePrompt } from "../nodes/prompt/compile.js";

export type BuildFile = { path: string; content: string };

export type ManifestNode = {
  id: string;
  type: Node["type"];
  label: string;
  parent?: string;
  settings: Node["settings"];
  file?: string;
};

export type ManifestOutput = { node: string; name: string; type: string };

export type Manifest = {
  version: 1;
  source?: BuildSource;
  inputs?: string[];
  outputs?: ManifestOutput[];
  session: Omit<Session, "frame">;
  nodes: ManifestNode[];
  wires: Wire[];
  files: Record<string, string>;
};

const compile = (node: Node, wires: readonly Wire[]): BuildFile | undefined => {
  switch (node.type) {
    case "prompt":
      return compilePrompt(node, handoffOf(node.id, wires));
    case "agent":
      return compileAgent(node, handoffOf(node.id, wires));
    default:
      return undefined;
  }
};

const declaredInputs = (nodes: readonly Node[]): string[] => [
  ...new Set(nodes.flatMap((node) => (node.type === "trigger" ? node.settings.inputs : []))),
];

const declaredOutputs = (nodes: readonly Node[]): ManifestOutput[] =>
  nodes.flatMap((node) =>
    node.type === "output"
      ? [{ node: node.id, name: node.settings.name, type: node.settings.type }]
      : [],
  );

export function lower(
  flow: Flow,
  source?: BuildSource,
): { manifest: Omit<Manifest, "files">; nodeFiles: BuildFile[] } {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const nodes = order(flow).flatMap((id) => byId.get(id) ?? []);
  const compiled = nodes.map((node) => ({ node, file: compile(node, flow.wires) }));
  const session = { ...flow.session };
  delete session.frame;
  const inputs = declaredInputs(nodes);
  const outputs = declaredOutputs(nodes);
  return {
    manifest: {
      version: 1,
      ...(source === undefined ? {} : { source }),
      ...(inputs.length === 0 ? {} : { inputs }),
      ...(outputs.length === 0 ? {} : { outputs }),
      session,
      nodes: compiled.map(({ node, file }) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        ...(node.parent === undefined ? {} : { parent: node.parent }),
        settings: node.settings,
        ...(file === undefined ? {} : { file: file.path }),
      })),
      wires: flow.wires,
    },
    nodeFiles: compiled.flatMap(({ file }) => file ?? []),
  };
}
