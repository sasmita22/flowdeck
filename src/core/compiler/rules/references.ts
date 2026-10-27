import type { Rule, ValidationError } from "../validate.js";

const id = "references";

export const rule: Rule = {
  id,
  message: "Wires and parents must name nodes that are in the flow.",
  check: (flow) => {
    const ids = new Set(flow.nodes.map((node) => node.id));
    const wireErrors = flow.wires.flatMap((wire, index) =>
      (["from", "to"] as const)
        .filter((end) => !ids.has(wire[end].node))
        .map((end): ValidationError => ({
          rule: id,
          wire: index,
          field: end,
          message: `Wire ${end} "${wire[end].node}" names no node in the flow.`,
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
