import type { Flow } from "../flow/schema.js";
import { rule as hardstopLocked } from "./rules/hardstop-locked.js";
import { rule as loopCap } from "./rules/loop-cap.js";
import { rule as loopSingleEntry } from "./rules/loop-single-entry.js";
import { rule as noCycle } from "./rules/no-cycle.js";
import { rule as ports } from "./rules/ports.js";
import { rule as references } from "./rules/references.js";
import { rule as requiredSettings } from "./rules/required-settings.js";

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
] satisfies readonly Rule[];

export function validate(flow: Flow): ValidationError[] {
  return rules.flatMap((rule) => rule.check(flow));
}
