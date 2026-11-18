import { flowContainerName, flowContainerNodesOfType } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "one-stop";

export const rule: Rule = {
  id,
  message: "Each workspace and session has at most one Stop.",
  check: (flow): ValidationError[] =>
    flow.containers.flatMap((container) => {
      const stops = flowContainerNodesOfType(flow, container, "output").length;
      return stops > 1
        ? [
            {
              rule: id,
              container: container.id,
              message: `${flowContainerName(container)} has ${stops} Stops; keep one.`,
            },
          ]
        : [];
    }),
};
