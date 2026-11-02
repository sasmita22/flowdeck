import { FlowCycleError, order } from "../../flow/order.js";
import type { Flow } from "../../flow/schema.js";
import { parallelSections } from "../../nodes/fork/execute.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "file-wires";

const runOrder = (flow: Flow): Map<string, number> | undefined => {
  try {
    return new Map(order(flow).map((nodeId, index) => [nodeId, index]));
  } catch (error) {
    if (error instanceof FlowCycleError) return undefined;
    throw error;
  }
};

const controlCharacter = /\p{Cc}/u;

export const insideFolder = (file: string) =>
  !file.startsWith("/") &&
  !file.startsWith("~") &&
  !file.includes(",") &&
  !controlCharacter.test(file) &&
  !file.split("/").includes("..");

const sideBySide = (flow: Flow) => {
  const { sections } = parallelSections(flow.nodes, flow.wires);
  return (a: string, b: string) =>
    sections.some(({ branches }) => branches.includes(a) && branches.includes(b));
};

export const rule: Rule = {
  id,
  message:
    "A File wire names a file inside the working folder, and comes from a node that runs before the one that needs it.",
  check: (flow) => {
    const positions = runOrder(flow);
    const parallel = sideBySide(flow);
    return flow.wires.flatMap((wire, index): ValidationError[] => {
      if (wire.kind !== "file") return [];
      const { file } = wire;
      const from = wire.from.node;
      const to = wire.to.node;
      const error = (message: string) => [{ rule: id, node: to, wire: index, message }];
      if (file.trim() === "") return error(`A File wire from ${from} to ${to} names no file.`);
      if (!insideFolder(file)) {
        return error(
          `File wire ${JSON.stringify(file)} from ${from} to ${to} must name a file inside the working folder, without ~, commas or control characters.`,
        );
      }
      if (from === to) return error(`${to} cannot need ${file} from itself.`);
      if (parallel(from, to)) {
        return error(`${to} needs ${file} from ${from}, but they run at the same time.`);
      }
      const producer = positions?.get(from);
      const consumer = positions?.get(to);
      if (producer !== undefined && consumer !== undefined && producer > consumer) {
        return error(`${to} needs ${file} from ${from}, but ${from} runs after it.`);
      }
      return [];
    });
  },
};
