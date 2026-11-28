import { labelOf } from "./labels.js";
import { reachableFrom } from "./paths.js";
import type { Flow, Node } from "./schema.js";
import { producedNames } from "./variables.js";

const alwaysGateSkipped =
  "This Gate is skipped in automatic runs and auto mode: it pauses only manual runs.";

const ownWarnings = (node: Node): string[] =>
  node.type === "gate" && node.settings.stopWhen === "always" ? [alwaysGateSkipped] : [];

const producerWarnings = (flow: Flow): Map<string, string[]> => {
  const warnings = new Map<string, string[]>();
  const warn = (id: string, text: string) => warnings.set(id, [...(warnings.get(id) ?? []), text]);
  const later = new Map(flow.nodes.map((node) => [node.id, reachableFrom(flow, node.id)]));
  const after = (from: string, to: string) => from !== to && (later.get(from)?.has(to) ?? false);
  const readers = (name: string) =>
    flow.nodes
      .filter((node) => node.type === "branch" && node.settings.variable === name)
      .map((node) => node.id);
  const names = new Set(flow.nodes.flatMap(producedNames));
  for (const name of names) {
    const producers = flow.nodes
      .filter((node) => producedNames(node).includes(name))
      .map((node) => node.id);
    const branches = readers(name);
    const readLater = (id: string) => branches.some((branch) => after(id, branch));
    for (const first of producers) {
      for (const second of producers) {
        if (first === second || !readLater(second)) continue;
        if (after(first, second)) {
          warn(
            first,
            `${labelOf(flow, first)} sets "${name}", but ${labelOf(flow, second)} sets it again later, so the Branch reads ${labelOf(flow, second)}'s value.`,
          );
        } else if (!after(second, first) && readLater(first)) {
          warn(
            first,
            `${labelOf(flow, first)} and ${labelOf(flow, second)} both set "${name}" side by side; the Branch reads whichever finishes last.`,
          );
        }
      }
    }
  }
  return warnings;
};

export const nodeWarnings = (flow: Flow): Record<string, string[]> => {
  const fromProducers = producerWarnings(flow);
  return Object.fromEntries(
    flow.nodes.flatMap((node) => {
      const warnings = [...ownWarnings(node), ...(fromProducers.get(node.id) ?? [])];
      return warnings.length === 0 ? [] : [[node.id, warnings]];
    }),
  );
};
