import type { Rule, ValidationError } from "../validate.js";

const id = "references";

export const rule: Rule = {
  id,
  message: "Wires must name nodes or containers in the flow, and parents must name nodes in it.",
  check: (flow) => {
    const ids = new Set(flow.nodes.map((node) => node.id));
    const ends = new Set([...ids, ...flow.containers.map((container) => container.id)]);
    const wireErrors = flow.wires.flatMap((wire, index) =>
      (["from", "to"] as const)
        .filter((end) => !ends.has(wire[end].node))
        .map((end): ValidationError => ({
          rule: id,
          wire: index,
          field: end,
          message: `Wire ${end} "${wire[end].node}" names no node or container in the flow.`,
        })),
    );
    const parentErrors = flow.nodes.flatMap((node): ValidationError[] =>
      node.parent !== undefined && !ids.has(node.parent)
        ? [
            {
              rule: id,
              node: node.id,
              field: "parent",
              message: `Parent "${node.parent}" names no node in the flow.`,
            },
          ]
        : [],
    );
    return [...wireErrors, ...parentErrors];
  },
};
