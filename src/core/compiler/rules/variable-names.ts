import { foundVariables, isVariableName } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-names";

export const rule: Rule = {
  id,
  message:
    "Variable names use only letters, digits, dashes and underscores, starting with a letter or digit.",
  check: (flow) =>
    foundVariables(flow)
      .filter(({ name }) => !isVariableName(name))
      .map(({ name, nodeIds }): ValidationError => ({
        rule: id,
        node: nodeIds[0],
        message: `Variable "${name}" may only use letters, digits, dashes and underscores, starting with a letter or digit.`,
      })),
};
