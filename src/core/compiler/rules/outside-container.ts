import { flowContainerOf, isWorkflow } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "outside-container";

export const rule: Rule = {
  id,
  message: "In a workflow, every node sits in the workspace or a session.",
  check: (flow): ValidationError[] =>
    isWorkflow(flow)
      ? flow.nodes
          .filter(
            (node) => node.parent === undefined && flowContainerOf(flow, node.id) === undefined,
          )
          .map((node) => ({
            rule: id,
            node: node.id,
            message: `${node.label} is outside every workspace and session; move it into one.`,
          }))
      : [],
};
