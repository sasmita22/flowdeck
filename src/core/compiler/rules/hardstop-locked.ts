import type { Rule, ValidationError } from "../validate.js";

const id = "hardstop-locked";

export const rule: Rule = {
  id,
  message: "A hard stop must stay enabled and locked.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "hardstop") return [];
      const errors: ValidationError[] = [];
      if (!node.settings.enabled) {
        errors.push({
          rule: id,
          node: node.id,
          field: "enabled",
          message: "Hard stop is disabled.",
        });
      }
      if (!node.settings.locked) {
        errors.push({
          rule: id,
          node: node.id,
          field: "locked",
          message: "Hard stop is unlocked.",
        });
      }
      return errors;
    }),
};
