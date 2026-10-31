import { parallelSections } from "../../nodes/fork/execute.js";
import type { Rule } from "../validate.js";

const id = "parallel-section";

export const rule: Rule = {
  id,
  message:
    "A parallel start must pair with one parallel end around two or more single Agent branches.",
  check: (flow) =>
    parallelSections(flow.nodes, flow.wires).problems.map(({ node, message }) => ({
      rule: id,
      node,
      message: `${node} ${message}`,
    })),
};
