import type { Rule, ValidationError } from "../validate.js";

const id = "repo-required";

export const rule: Rule = {
  id,
  message: "A blueprint must name the repository it builds from.",
  check: ({ session: { buildConfig } }): ValidationError[] =>
    buildConfig.repo === undefined || buildConfig.repo === ""
      ? [
          {
            rule: id,
            field: "buildConfig.repo",
            message:
              "Choose the repository this blueprint builds from, in the session settings. Build is refused until one is set.",
          },
        ]
      : [],
};
