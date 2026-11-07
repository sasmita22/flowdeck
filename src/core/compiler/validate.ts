import type { Flow } from "../flow/schema.js";
import { rule as agentTools } from "./rules/agent-tools.js";
import { rule as bodyNodes } from "./rules/body-nodes.js";
import { rule as branchVariable } from "./rules/branch-variable.js";
import { rule as fileWires } from "./rules/file-wires.js";
import { rule as hardstopLocked } from "./rules/hardstop-locked.js";
import { rule as loopBody } from "./rules/loop-body.js";
import { rule as loopCap } from "./rules/loop-cap.js";
import { rule as loopSingleEntry } from "./rules/loop-single-entry.js";
import { rule as noCycle } from "./rules/no-cycle.js";
import { rule as nodeIds } from "./rules/node-ids.js";
import { rule as parallelSection } from "./rules/parallel-section.js";
import { rule as ports } from "./rules/ports.js";
import { rule as references } from "./rules/references.js";
import { rule as repoRequired } from "./rules/repo-required.js";
import { rule as requiredSettings } from "./rules/required-settings.js";
import { rule as undeclaredVariable } from "./rules/undeclared-variable.js";
import { rule as variableNames } from "./rules/variable-names.js";

export type ValidationError = {
  rule: string;
  message: string;
  node?: string;
  wire?: number;
  field?: string;
};

export type Rule = {
  id: string;
  message: string;
  check(flow: Flow): ValidationError[];
};

export const rules = [
  loopCap,
  hardstopLocked,
  requiredSettings,
  ports,
  references,
  noCycle,
  loopSingleEntry,
  nodeIds,
  parallelSection,
  loopBody,
  bodyNodes,
  branchVariable,
  fileWires,
  undeclaredVariable,
  variableNames,
  repoRequired,
  agentTools,
] satisfies readonly Rule[];

export function validate(flow: Flow): ValidationError[] {
  return rules.flatMap((rule) => rule.check(flow));
}
