import { decidedByValue } from "../../nodes/branch/settings.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "branch-variable";

export const rule: Rule = {
  id,
  message: "A Branch decided by a variable must name it, and cannot sit inside a Loop body.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "branch") return [];
      const errors: ValidationError[] = [];
      const { variable } = node.settings;
      const byVariable = !decidedByValue(node.settings);
      if (byVariable && variable === "") {
        errors.push({
          rule: id,
          node: node.id,
          field: "variable",
          message: `${node.id} has no variable picked; pick a yes/no variable to branch on.`,
        });
      }
      if (node.parent !== undefined) {
        errors.push({
          rule: id,
          node: node.id,
          message: `${node.id} is inside ${node.parent}; a Branch cannot sit inside a Loop body.`,
        });
      }
      return errors;
    }),
};
