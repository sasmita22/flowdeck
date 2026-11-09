import type { Rule, ValidationError } from "../validate.js";

const id = "stop-required";

export const rule: Rule = {
  id,
  message: "A blueprint needs a Stop on its main flow.",
  check: ({ nodes }): ValidationError[] =>
    nodes.some((node) => node.type === "output")
      ? []
      : [{ rule: id, message: "A blueprint needs a Stop on its main flow." }],
};
