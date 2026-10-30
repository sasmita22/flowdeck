import { order } from "../flow/order.js";
import type { Flow, Node, Session, Wire } from "../flow/schema.js";
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

export type Manifest = {
  version: 1;
  session: Omit<Session, "frame">;
  nodes: ManifestNode[];
  wires: Wire[];
  files: Record<string, string>;
};

const compile = (node: Node): BuildFile | undefined => {
  switch (node.type) {
    case "prompt":
      return compilePrompt(node);
    case "agent":
      return compileAgent(node);
    default:
      return undefined;
  }
};

export function lower(flow: Flow): { manifest: Omit<Manifest, "files">; nodeFiles: BuildFile[] } {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const nodes = order(flow).flatMap((id) => byId.get(id) ?? []);
  const compiled = nodes.map((node) => ({ node, file: compile(node) }));
  const session = { ...flow.session };
  delete session.frame;
  return {
    manifest: {
      version: 1,
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
