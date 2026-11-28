import { labelOf } from "../../flow/labels.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-dot";

export const rule: Rule = {
  id,
  message: "A Branch's variable name holds no dot, which marks a library's own variable.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] =>
      node.type === "branch" && node.settings.variable.includes(".")
        ? [
            {
              rule: id,
              node: node.id,
              field: "variable",
              message: `${labelOf(flow, node.id)} names "${node.settings.variable}"; a variable name cannot hold a dot, which marks a library's own variable.`,
            },
          ]
        : [],
    ),
};
