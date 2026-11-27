import { labelOf } from "../../flow/labels.js";
import type { Node } from "../../flow/schema.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "gate-condition";

export const rule: Rule = {
  id,
  message: "A Conditional Gate needs the condition an agent checks before the run goes on.",
  check: (flow) =>
    flow.nodes.flatMap((node: Node): ValidationError[] =>
      node.type === "gate" &&
      node.settings.stopWhen === "conditional" &&
      node.settings.condition.trim() === ""
        ? [
            {
              rule: id,
              node: node.id,
              field: "condition",
              message: `${labelOf(flow, node.id)} stops on a condition, but has none written; write when it should stop.`,
            },
          ]
        : [],
    ),
};
