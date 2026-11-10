import type { Flow, Node } from "../flow/schema.js";

const maxLength = 64;
const orchestrator = "run";

const cut = (name: string, length: number) => name.slice(0, length).replace(/-+$/, "");

const kebab = (label: string) =>
  label
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const baseName = (node: Node) => cut(kebab(node.label), maxLength) || node.type;

const firstFree = (base: string, taken: ReadonlySet<string>) => {
  if (!taken.has(base)) return base;
  for (let count = 2; ; count++) {
    const suffix = `-${count}`;
    const name = `${cut(base, maxLength - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
};

export function pieceNames(flow: Flow): ReadonlyMap<string, string> {
  const taken = new Set([orchestrator]);
  const names = new Map<string, string>();
  for (const node of flow.nodes) {
    if (node.type !== "agent") continue;
    const name = firstFree(baseName(node), taken);
    taken.add(name);
    names.set(node.id, name);
  }
  return names;
}

export function pieceOf(node: { id: string; piece?: string }): string {
  return node.piece ?? node.id;
}
