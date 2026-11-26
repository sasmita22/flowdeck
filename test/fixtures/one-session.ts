import type { Manifest, ManifestContainer } from "../../src/core/compiler/lower.js";

type OneSession<M> = M & Pick<ManifestContainer, "nodes" | "wires" | "prefix">;

export function oneSession<M extends Pick<Manifest, "containers">>(manifest: M): OneSession<M> {
  const sessions = manifest.containers.filter((container) => container.kind === "session");
  const [only] = sessions;
  if (sessions.length !== 1 || only === undefined) {
    throw new Error("expected a manifest with exactly one session container");
  }
  return { ...manifest, nodes: only.nodes, wires: only.wires, prefix: only.prefix };
}
