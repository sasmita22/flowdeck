import { FlowCycleError, order } from "../../flow/order.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "no-cycle";

export const rule: Rule = {
  id,
  message: "Then wires and parents must not form a cycle outside a loop.",
  check: (flow) => {
    try {
      order(flow);
      return [];
    } catch (error) {
      if (!(error instanceof FlowCycleError)) throw error;
      return error.nodeIds.map((node): ValidationError => ({
        rule: id,
        node,
        message: error.message,
      }));
    }
  },
};
