import type { Flow } from "../flow/schema.js";
import { rule as bodyNodes } from "./rules/body-nodes.js";
import { rule as branchValue } from "./rules/branch-value.js";
import { rule as branchVariable } from "./rules/branch-variable.js";
import { rule as handoffs } from "./rules/handoffs.js";
import { rule as hardstopLocked } from "./rules/hardstop-locked.js";
import { rule as loopBody } from "./rules/loop-body.js";
import { rule as loopCap } from "./rules/loop-cap.js";
import { rule as loopSingleEntry } from "./rules/loop-single-entry.js";
import { rule as noCycle } from "./rules/no-cycle.js";
import { rule as nodeIds } from "./rules/node-ids.js";
import { rule as oneStart } from "./rules/one-start.js";
import { rule as oneStop } from "./rules/one-stop.js";
import { rule as outsideContainer } from "./rules/outside-container.js";
import { rule as parallelSection } from "./rules/parallel-section.js";
import { rule as ports } from "./rules/ports.js";
import { rule as references } from "./rules/references.js";
import { rule as requiredSettings } from "./rules/required-settings.js";
import { rule as sessionConnections } from "./rules/session-connections.js";
import { rule as sessionNames } from "./rules/session-names.js";
import { rule as sessionSettings } from "./rules/session-settings.js";
import { rule as stopRequired } from "./rules/stop-required.js";
import { rule as variableKind } from "./rules/variable-kind.js";
import { rule as variableNames } from "./rules/variable-names.js";
import { rule as workspaceCount } from "./rules/workspace-count.js";

export type ValidationError = {
  rule: string;
  message: string;
  node?: string;
  wire?: number;
  field?: string;
  container?: string;
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
  branchValue,
  handoffs,
  variableKind,
  variableNames,
  workspaceCount,
  sessionSettings,
  sessionNames,
  sessionConnections,
  outsideContainer,
  oneStart,
  stopRequired,
  oneStop,
] satisfies readonly Rule[];

export function validate(flow: Flow): ValidationError[] {
  return rules.flatMap((rule) => rule.check(flow));
}
