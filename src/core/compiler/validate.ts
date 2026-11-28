import { unknownLibraries, type LibraryLookup } from "../flow/libraries.js";
import type { Flow } from "../flow/schema.js";
import { rule as bodyNodes } from "./rules/body-nodes.js";
import { rule as branchVariable } from "./rules/branch-variable.js";
import { rule as containerWires } from "./rules/container-wires.js";
import { rule as gateCondition } from "./rules/gate-condition.js";
import { rule as libraryLabels } from "./rules/library-labels.js";
import { rule as libraryLoops } from "./rules/library-loops.js";
import { rule as libraryUse } from "./rules/library-use.js";
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
import { rule as produceRows } from "./rules/produce-rows.js";
import { rule as references } from "./rules/references.js";
import { rule as requiredSettings } from "./rules/required-settings.js";
import { rule as sessionConnections } from "./rules/session-connections.js";
import { rule as sessionNames } from "./rules/session-names.js";
import { rule as sessionSettings } from "./rules/session-settings.js";
import { rule as stopRequired } from "./rules/stop-required.js";
import { rule as variableClash } from "./rules/variable-clash.js";
import { rule as variableDot } from "./rules/variable-dot.js";
import { rule as variableKind } from "./rules/variable-kind.js";
import { rule as variableNames } from "./rules/variable-names.js";
import { rule as variableUnique } from "./rules/variable-unique.js";
import { rule as workflowPath } from "./rules/workflow-path.js";
import { rule as workspaceCount } from "./rules/workspace-count.js";

export type ValidationError = {
  rule: string;
  message: string;
  node?: string;
  wire?: number;
  field?: string;
  container?: string;
};

export type RuleContext = { libraries: LibraryLookup };

export type Rule = {
  id: string;
  message: string;
  check(flow: Flow, context?: RuleContext): ValidationError[];
};

export const rules = [
  loopCap,
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
  produceRows,
  gateCondition,
  variableKind,
  variableNames,
  workspaceCount,
  sessionSettings,
  sessionNames,
  sessionConnections,
  outsideContainer,
  workflowPath,
  containerWires,
  libraryUse,
  libraryLabels,
  libraryLoops,
  variableUnique,
  variableClash,
  variableDot,
  oneStart,
  stopRequired,
  oneStop,
] satisfies readonly Rule[];

export function validate(
  flow: Flow,
  libraries: LibraryLookup = unknownLibraries,
): ValidationError[] {
  return rules.flatMap((rule) => rule.check(flow, { libraries }));
}

export function validateExpanded(flow: Flow): ValidationError[] {
  return validate(flow).filter((error) => error.rule !== variableDot.id);
}
