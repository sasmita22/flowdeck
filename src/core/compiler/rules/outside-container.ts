import { canvasStart } from "../../flow/main-flow.js";
import type { Node } from "../../flow/schema.js";
import { flowContainerOf, isWorkflow } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "outside-container";

const onCanvasPath = (node: Node, start: string | undefined) =>
  node.id === start || node.type === "output" || node.type === "library";

export const rule: Rule = {
  id,
  message:
    "In a workflow, every node except the canvas Start, the canvas Stop and library nodes sits in the workspace or a session.",
  check: (flow): ValidationError[] => {
    if (!isWorkflow(flow)) return [];
    const start = canvasStart(flow);
    return flow.nodes
      .filter(
        (node) =>
          node.parent === undefined &&
          flowContainerOf(flow, node.id) === undefined &&
          !onCanvasPath(node, start),
      )
      .map((node) => ({
        rule: id,
        node: node.id,
        message: `${node.label} is outside every workspace and session; move it into one.`,
      }));
  },
};
