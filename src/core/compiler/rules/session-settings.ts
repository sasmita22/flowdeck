import type { FlowContainer } from "../../flow/schema.js";
import { flowContainerName } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "session-settings";

const labels = { repo: "repository", branch: "branch", model: "model" } as const;

type Setting = keyof typeof labels;

const settingsOf = (container: FlowContainer): [Setting, string][] =>
  container.kind === "workspace"
    ? [["model", container.model]]
    : [
        ["repo", container.repo],
        ["branch", container.branch],
        ["model", container.model],
      ];

export const rule: Rule = {
  id,
  message: "Each session needs a repository, branch and model; the workspace needs a model.",
  check: ({ containers }): ValidationError[] =>
    containers.flatMap((container) =>
      settingsOf(container)
        .filter(([, value]) => value === "")
        .map(([field]) => ({
          rule: id,
          container: container.id,
          field,
          message: `${flowContainerName(container)} needs a ${labels[field]}. Build is refused until one is set.`,
        })),
    ),
};
