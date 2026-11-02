import { bodyProblems } from "../../flow/structure.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "body-nodes";

export const rule: Rule = {
  id,
  message: "A Trigger or Output cannot sit inside a Loop or For each body.",
  check: (flow) =>
    bodyProblems(flow.nodes)
      .filter((problem) => problem.outOfPlace === true)
      .map(({ node, message }): ValidationError => ({ rule: id, node, message: `${message}.` })),
};
