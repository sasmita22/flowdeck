import { labelOf, labelsOf } from "../../flow/labels.js";
import { coveredOnEveryPath, reachableFrom } from "../../flow/paths.js";
import type { Flow, Node } from "../../flow/schema.js";
import { producersOf } from "../../nodes/branch/execute.js";
import { decidedByValue } from "../../nodes/branch/settings.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "branch-value";

const problem = (flow: Flow, branch: string, value: string | undefined): string | undefined => {
  if (value === undefined || value === "") {
    return `${branch} is decided by a value an earlier Agent produces, but has no value picked; pick one.`;
  }
  const producers = [...producersOf(flow.nodes, value)];
  if (producers.length === 0) {
    return `${branch} reads "${value}", but no Agent produces it.`;
  }
  if (coveredOnEveryPath(flow, branch, producers)) return undefined;
  const later = reachableFrom(flow, branch);
  return producers.every((producer) => later.has(producer))
    ? `${branch} reads "${value}", but ${labelsOf(flow, producers)} produces it only after ${labelOf(flow, branch)}.`
    : `${branch} reads "${value}", but not every path to ${labelOf(flow, branch)} runs an Agent that produces it first.`;
};

export const rule: Rule = {
  id,
  message:
    "A Branch decided by a value reads one an Agent produces, and that Agent runs before it on every path.",
  check: (flow) =>
    flow.nodes.flatMap((node: Node): ValidationError[] => {
      if (node.type !== "branch" || !decidedByValue(node.settings)) return [];
      const message = problem(flow, node.id, node.settings.value);
      return message === undefined ? [] : [{ rule: id, node: node.id, field: "value", message }];
    }),
};
