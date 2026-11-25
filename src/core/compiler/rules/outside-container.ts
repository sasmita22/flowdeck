import { canvasStart } from "../../flow/main-flow.js";
import type { Node } from "../../flow/schema.js";
import { flowContainerOf, isWorkflow } from "../../flow/structure.js";
import type { Rule, RuleContext, ValidationError } from "../validate.js";

const id = "outside-container";

const onCanvasPath = (node: Node, start: string | undefined, context?: RuleContext) =>
  node.id === start ||
  node.type === "output" ||
  (node.type === "library" &&
    context?.libraries(node.settings.libraryId)?.kind === "session-library");

export const rule: Rule = {
  id,
  message:
    "In a workflow, every node except the canvas Start, the canvas Stop and session library nodes sits in the workspace or a session.",
  check: (flow, context): ValidationError[] => {
    if (!isWorkflow(flow)) return [];
    const start = canvasStart(flow);
    return flow.nodes
      .filter(
        (node) =>
          node.parent === undefined &&
          flowContainerOf(flow, node.id) === undefined &&
          !onCanvasPath(node, start, context),
      )
      .map((node) => ({
        rule: id,
        node: node.id,
        message: `${node.label} is outside every workspace and session; move it into one.`,
      }));
  },
};
