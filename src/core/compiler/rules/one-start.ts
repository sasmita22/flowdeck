import { flowContainerName, flowContainerNodesOfType } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "one-start";

export const rule: Rule = {
  id,
  message: "Each workspace and session needs exactly one Start.",
  check: (flow): ValidationError[] =>
    flow.containers.flatMap((container) =>
      flowContainerNodesOfType(flow, container, "trigger").length === 1
        ? []
        : [
            {
              rule: id,
              container: container.id,
              message: `${flowContainerName(container)} needs exactly one Start.`,
            },
          ],
    ),
};
