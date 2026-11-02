import type { Rule, ValidationError } from "../validate.js";

const id = "session-folder";

export const rule: Rule = {
  id,
  message: "A session that works in an existing folder must name that folder.",
  check: ({ session: { workingFolder } }): ValidationError[] =>
    workingFolder.kind === "path" && workingFolder.path.trim() === ""
      ? [
          {
            rule: id,
            field: "workingFolder.path",
            message: "Choose the folder this blueprint works in, in the session settings.",
          },
        ]
      : [],
};
