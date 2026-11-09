import type { Rule, ValidationError } from "../validate.js";

const id = "one-start";

export const rule: Rule = {
  id,
  message: "A blueprint needs exactly one Start.",
  check: ({ nodes }): ValidationError[] => {
    const starts = nodes.filter((node) => node.type === "trigger").length;
    return starts === 1
      ? []
      : [
          {
            rule: id,
            message: `A blueprint needs exactly one Start; it has ${starts === 0 ? "none" : starts}.`,
          },
        ];
  },
};
