import type { Rule, ValidationError } from "../validate.js";

const id = "loop-cap";

export const rule: Rule = {
  id,
  message: "Every loop needs a cap of at least 1 and an action for when it is reached.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "loop") return [];
      const { cap, onCap } = node.settings;
      const errors: ValidationError[] = [];
      if (cap === undefined) {
        errors.push({ rule: id, node: node.id, field: "cap", message: "Loop has no cap." });
      } else if (!Number.isInteger(cap) || cap < 1) {
        errors.push({
          rule: id,
          node: node.id,
          field: "cap",
          message: `Loop cap ${cap} is not a whole number of at least 1.`,
        });
      }
      if (onCap === undefined) {
        errors.push({
          rule: id,
          node: node.id,
          field: "onCap",
          message: "Loop has no action for when its cap is reached.",
        });
      }
      return errors;
    }),
};
