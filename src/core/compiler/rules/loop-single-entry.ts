import type { Flow } from "../../flow/schema.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "loop-single-entry";

const scopes = (flow: Flow) => {
  const parentOf = new Map(flow.nodes.map((node) => [node.id, node.parent]));
  const chain = (nodeId: string): string[] => {
    const ancestors: string[] = [];
    for (let at = parentOf.get(nodeId); at !== undefined && !ancestors.includes(at);) {
      ancestors.push(at);
      at = parentOf.get(at);
    }
    return ancestors;
  };
  const inside = (nodeId: string, scope: string) => chain(nodeId).includes(scope);
  const unitIn = (scope: string, nodeId: string) => {
    const ancestors = [nodeId, ...chain(nodeId)];
    return ancestors[ancestors.indexOf(scope) - 1] ?? nodeId;
  };
  return { inside, unitIn };
};

export const rule: Rule = {
  id,
  message: "A loop body must have exactly one entry.",
  check: (flow) => {
    const ids = new Set(flow.nodes.map((node) => node.id));
    const { inside, unitIn } = scopes(flow);
    const wires = flow.wires.filter(
      (wire) => wire.kind === "then" && ids.has(wire.from.node) && ids.has(wire.to.node),
    );
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "loop" && node.type !== "foreach") return [];
      const entries = new Set(
        wires
          .filter((wire) => inside(wire.to.node, node.id))
          .filter((wire) => wire.from.node === node.id || !inside(wire.from.node, node.id))
          .map((wire) => unitIn(node.id, wire.to.node)),
      );
      if (entries.size <= 1) return [];
      return [
        {
          rule: id,
          node: node.id,
          message:
            node.type === "loop"
              ? `Loop body has ${entries.size} entries: ${[...entries].join(", ")}.`
              : `${node.id} (foreach) body has ${entries.size} entries: ${[...entries].join(", ")}.`,
        },
      ];
    });
  },
};
