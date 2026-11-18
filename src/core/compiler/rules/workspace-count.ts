import type { Rule, ValidationError } from "../validate.js";

const id = "workspace-count";

export const rule: Rule = {
  id,
  message: "A blueprint has at most one workspace.",
  check: ({ containers }): ValidationError[] =>
    containers
      .filter((container) => container.kind === "workspace")
      .slice(1)
      .map((container) => ({
        rule: id,
        container: container.id,
        message: "A blueprint has at most one workspace. Remove this one.",
      })),
};
