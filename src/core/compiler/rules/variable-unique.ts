import { labelOf } from "../../flow/labels.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-unique";

export const rule: Rule = {
  id,
  message:
    "Each Branch types a variable no earlier Branch uses; to share one, pick it from use existing.",
  check: (flow) => {
    const claimed = new Map<string, string>();
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "branch" || node.settings.variable === "") return [];
      const { variable, shared } = node.settings;
      const first = claimed.get(variable);
      if (first === undefined) {
        claimed.set(variable, node.id);
        return [];
      }
      if (shared === true) return [];
      return [
        {
          rule: id,
          node: node.id,
          field: "variable",
          message: `${labelOf(flow, node.id)} types "${variable}", which ${labelOf(flow, first)} already uses; pick it from use existing to share it, or name another variable.`,
        },
      ];
    });
  },
};
