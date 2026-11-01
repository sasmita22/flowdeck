import { triggerFlags } from "../../nodes/branch/execute.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "branch-flag";

export const rule: Rule = {
  id,
  message:
    "A Branch must name a boolean flag on the Trigger, and cannot sit inside a Loop or For each body.",
  check: (flow) => {
    const flags = triggerFlags(flow.nodes);
    return flow.nodes.flatMap((node): ValidationError[] => {
      if (node.type !== "branch") return [];
      const errors: ValidationError[] = [];
      if (!(node.settings.flag in flags)) {
        errors.push({
          rule: id,
          node: node.id,
          message: `${node.id} branches on "${node.settings.flag}", which must be a boolean flag on the Trigger.`,
        });
      }
      if (node.parent !== undefined) {
        errors.push({
          rule: id,
          node: node.id,
          message: `${node.id} is inside ${node.parent}; a Branch cannot sit inside a Loop or For each body.`,
        });
      }
      return errors;
    });
  },
};
