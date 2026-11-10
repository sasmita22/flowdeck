import { referencedVariables } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "undeclared-variable";

export const rule: Rule = {
  id,
  message: "Every {{name}} in an Agent must be a variable declared in Build configuration.",
  check: (flow) => {
    const declared = new Set(flow.session.buildConfig.variables.map(({ name }) => name));
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "agent") return [];
      return referencedVariables(node.settings.instructions)
        .filter((name) => !declared.has(name))
        .map((name) => ({
          rule: id,
          node: node.id,
          field: "instructions",
          message: `${node.id} uses {{${name}}}, which is not declared in Build configuration.`,
        }));
    });
  },
};
