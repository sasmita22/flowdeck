import { canvasReach, reachFrom } from "../../flow/main-flow.js";
import { flowContainerOf, isWorkflow } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "workflow-path";

const message = "A workflow runs from its Start through the workspace to its Stop.";

export const rule: Rule = {
  id,
  message,
  check: (flow): ValidationError[] => {
    if (!isWorkflow(flow)) return [];
    const reach = canvasReach(flow);
    const workspace = flow.containers.find((container) => container.kind === "workspace");
    if (workspace === undefined || reach?.containers.has(workspace.id) !== true) {
      return [{ rule: id, message }];
    }
    const onward = reachFrom(flow, workspace.id);
    const reachesStop = flow.nodes.some(
      (node) =>
        node.type === "output" &&
        node.parent === undefined &&
        flowContainerOf(flow, node.id) === undefined &&
        onward.reached.has(node.id),
    );
    return reachesStop ? [] : [{ rule: id, message }];
  },
};
