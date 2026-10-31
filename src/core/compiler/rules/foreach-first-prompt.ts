import { FlowCycleError, order } from "../../flow/order.js";
import type { Flow } from "../../flow/schema.js";
import { firstTurnId } from "../../nodes/foreach/execute.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "foreach-first-prompt";

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
  message: "A For each body must start its turns with a prompt.",
  check: (flow) => {
    const nodes = ordered(flow);
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "foreach") return [];
      const body = nodes.filter((child) => child.parent === node.id);
      const turnId = firstTurnId(body);
      const turn = body.find((child) => child.id === turnId);
      if (turn?.type === "prompt") return [];
      return [
        {
          rule: id,
          node: node.id,
          message:
            turn === undefined
              ? `${node.id} (foreach) has no prompt in its body.`
              : `${node.id} (foreach) starts its body with ${turn.id} (${turn.type}); the first turn must be a prompt.`,
        },
      ];
    });
  },
};
