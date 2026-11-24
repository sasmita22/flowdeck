import type { LibraryLookup } from "../flow/libraries.js";
import type { Flow } from "../flow/schema.js";
import { mainFlowOnly } from "../flow/main-flow.js";
import { validate, type ValidationError } from "./validate.js";

export function flowProblems(flow: Flow, libraries?: LibraryLookup): ValidationError[] {
  const checked = mainFlowOnly(flow);
  return validate(checked, libraries).map((problem) => {
    const checkedWire = problem.wire === undefined ? undefined : checked.wires[problem.wire];
    return checkedWire === undefined
      ? problem
      : { ...problem, wire: flow.wires.indexOf(checkedWire) };
  });
}
