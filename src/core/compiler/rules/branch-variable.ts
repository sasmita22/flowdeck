import { decidedByValue } from "../../nodes/branch/settings.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "branch-variable";

export const rule: Rule = {
  id,
  message:
    "A Branch must pick a yes/no variable declared in Build configuration, and cannot sit inside a Loop or For each body.",
  check: (flow) => {
    const yesno = new Set(
      flow.session.buildConfig.variables
        .filter((variable) => variable.kind === "yesno")
        .map(({ name }) => name),
    );
    return flow.nodes.flatMap((node): ValidationError[] => {
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
      } else if (byVariable && !yesno.has(variable)) {
        errors.push({
          rule: id,
          node: node.id,
          field: "variable",
          message: `${node.id} branches on "${variable}", which must be a yes/no variable declared in Build configuration.`,
        });
      }
      if (node.parent !== undefined) {
        errors.push({
          rule: id,
          node: node.id,
          message: `${node.id} is inside ${node.parent}; a Branch cannot sit inside a Loop or For each body.`,
        });
      }
      return errors;
    });
  },
};
