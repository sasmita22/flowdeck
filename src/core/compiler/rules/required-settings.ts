import type { Rule, ValidationError } from "../validate.js";

const id = "required-settings";

export const rule: Rule = {
  id,
  message: "An agent needs instructions.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] =>
      node.type === "agent" && node.settings.instructions.trim() === ""
        ? [
            {
              rule: id,
              node: node.id,
              field: "instructions",
              message: "Agent has no instructions.",
            },
          ]
        : [],
    ),
};
