import { safeName } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "node-ids";

export const rule: Rule = {
  id,
  message:
    "Node ids must be unique and use only letters, digits, dashes and underscores, starting with a letter or digit.",
  check: (flow) => {
    const seen = new Set<string>();
    return flow.nodes.flatMap((node): ValidationError[] => {
      const key = node.id.toLowerCase();
      const repeated = seen.has(key);
      seen.add(key);
      if (repeated) {
        return [
          {
            rule: id,
            node: node.id,
            field: "id",
            message: `Node id "${node.id}" is used more than once.`,
          },
        ];
      }
      if (!safeName.test(node.id)) {
        return [
          {
            rule: id,
            node: node.id,
            field: "id",
            message: `Node id "${node.id}" may only use letters, digits, dashes and underscores, starting with a letter or digit.`,
          },
        ];
      }
      return [];
    });
  },
};
