import type { Rule, ValidationError } from "../validate.js";

const id = "foreach-nesting";

export const rule: Rule = {
  id,
  message:
    "A For each cannot sit inside a loop or a For each, and a loop cannot sit inside a For each.",
  check: (flow) => {
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    return flow.nodes.flatMap((node): ValidationError[] => {
      const parent = node.parent === undefined ? undefined : byId.get(node.parent);
      if (parent === undefined) return [];
      const refused =
        (node.type === "foreach" && (parent.type === "loop" || parent.type === "foreach")) ||
        (node.type === "loop" && parent.type === "foreach");
      if (!refused) return [];
      return [
        {
          rule: id,
          node: node.id,
          message: `${node.id} (${node.type}) is inside ${parent.id} (${parent.type}); they cannot nest.`,
        },
      ];
    });
  },
};
