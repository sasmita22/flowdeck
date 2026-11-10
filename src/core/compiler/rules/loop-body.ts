import { FlowCycleError, order } from "../../flow/order.js";
import type { Flow } from "../../flow/schema.js";
import { bodyProblems } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "loop-body";

const ordered = (flow: Flow) => {
  try {
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    return order(flow).flatMap((nodeId) => byId.get(nodeId) ?? []);
  } catch (error) {
    if (error instanceof FlowCycleError) return flow.nodes;
    throw error;
  }
};

export const rule: Rule = {
  id,
  message:
    "A Loop or For each needs an Agent in its body, cannot sit inside another, and only they can hold a body.",
  check: (flow) =>
    bodyProblems(ordered(flow))
      .filter((problem) => problem.parentMissing !== true && problem.outOfPlace !== true)
      .map(({ node, message }): ValidationError => ({ rule: id, node, message: `${message}.` })),
};
