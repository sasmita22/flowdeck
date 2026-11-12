import { handoffPairs, type HandoffPair } from "../../flow/handoff.js";
import { labelOf, labelsOf } from "../../flow/labels.js";
import { coveredOnEveryPath, reachableFrom } from "../../flow/paths.js";
import type { Flow } from "../../flow/schema.js";
import { parallelSections } from "../../nodes/fork/execute.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "handoffs";

const controlCharacter = /\p{Cc}/u;

const insideFolder = (file: string) =>
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

const problem = (
  flow: Flow,
  parallel: (a: string, b: string) => boolean,
  { file, reader, writers }: HandoffPair,
): string | undefined => {
  const named = labelsOf(flow, writers);
  if (!insideFolder(file)) {
    return `${reader} is given ${JSON.stringify(file)}, written by ${named}, but a hand-off file must be inside the working folder, without ~, commas or control characters.`;
  }
  const alongside = writers.filter((writer) => parallel(reader, writer));
  if (alongside.length > 0) {
    return `${reader} is given ${file} from ${labelsOf(flow, alongside)}, but they run at the same time.`;
  }
  if (coveredOnEveryPath(flow, reader, writers)) return undefined;
  const later = reachableFrom(flow, reader);
  const after = writers.filter((writer) => later.has(writer));
  return after.length === writers.length
    ? `${reader} is given ${file} from ${named}, but ${named} runs after it.`
    : `${reader} is given ${file}, but not every path to ${labelOf(flow, reader)} runs ${named} first.`;
};

export const rule: Rule = {
  id,
  message:
    "A hand-off file is inside the working folder, and an Agent that writes it runs before every Agent given it.",
  check: (flow) => {
    const parallel = sideBySide(flow);
    return handoffPairs(flow.nodes).flatMap((pair): ValidationError[] => {
      const message = problem(flow, parallel, pair);
      return message === undefined ? [] : [{ rule: id, node: pair.reader, message }];
    });
  },
};
