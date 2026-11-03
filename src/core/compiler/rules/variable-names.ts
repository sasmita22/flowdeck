import { isVariableName } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-names";
const field = "buildConfig.variables";

export const rule: Rule = {
  id,
  message:
    "Variable names must be unique and use only letters, digits, dashes and underscores, starting with a letter or digit.",
  check: (flow) => {
    const seen = new Set<string>();
    return flow.session.buildConfig.variables.flatMap(({ name }): ValidationError[] => {
      const repeated = seen.has(name);
      seen.add(name);
      if (repeated) {
        return [{ rule: id, field, message: `Variable "${name}" is declared more than once.` }];
      }
      if (!isVariableName(name)) {
        return [
          {
            rule: id,
            field,
            message: `Variable "${name}" may only use letters, digits, dashes and underscores, starting with a letter or digit.`,
          },
        ];
      }
      return [];
    });
  },
};
