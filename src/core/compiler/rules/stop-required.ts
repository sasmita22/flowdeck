import { flowContainerName, flowContainerNodesOfType } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "stop-required";

export const rule: Rule = {
  id,
  message: "Each workspace and session needs a Stop its Start reaches.",
  check: (flow): ValidationError[] =>
    flow.containers.flatMap((container) =>
      flowContainerNodesOfType(flow, container, "output").length > 0
        ? []
        : [
            {
              rule: id,
              container: container.id,
              message: `${flowContainerName(container)} needs a Stop its Start reaches.`,
            },
          ],
    ),
};
