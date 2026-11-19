import type { Manifest } from "../../src/core/compiler/lower.js";

type OneSession<M> = M & Required<Pick<Manifest, "nodes" | "wires" | "prefix">>;

export function oneSession<M extends Partial<Manifest>>(manifest: M): OneSession<M> {
  const { nodes, wires, prefix } = manifest;
  if (nodes === undefined || wires === undefined || prefix === undefined) {
    throw new Error("expected a manifest with exactly one session container");
  }
  return { ...manifest, nodes, wires, prefix };
}
