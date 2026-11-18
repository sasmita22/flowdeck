import { foundVariables } from "../../flow/variables.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "variable-kind";

export const rule: Rule = {
  id,
  message: "A variable is either a yes/no a Branch decides on or text an Agent uses, not both.",
  check: (flow) => {
    const found = foundVariables(flow);
    return found
      .filter(({ kind }) => kind === "yes-no")
      .flatMap(({ name, nodeIds: branches }): ValidationError[] => {
        const text = found.find((entry) => entry.name === name && entry.kind === "text");
        if (text === undefined) return [];
        return [
          {
            rule: id,
            node: branches[0],
            message: `Variable "${name}" is a yes/no in ${branches.join(", ")} and text in ${text.nodeIds.join(", ")}; give one of them another name.`,
          },
        ];
      });
  },
};
