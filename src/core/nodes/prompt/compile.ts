import { scopeLine, type ScopeParts } from "../../compiler/scope-line.js";
import { handoffFolderLine, handoffText, type Handoff } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { fillVariables, type VariableValues } from "../../flow/variables.js";

export type PromptCompileInputs = {
  piece: string;
  scope: ScopeParts;
  wired?: Handoff;
  values?: VariableValues;
};

const orNone = (text: string) => (text.trim() === "" ? "None." : text.trim());

export function compilePrompt(
  node: Extract<Node, { type: "prompt" }>,
  inputs: PromptCompileInputs,
): {
  path: string;
  content: string;
} {
  const { piece, scope, wired = { given: [], writes: [] }, values = {} } = inputs;
  const { instructions, expectedOutput } = node.settings;
  const frontmatter = [
    `name: ${JSON.stringify(piece)}`,
    `description: ${JSON.stringify(`${scopeLine(scope)} ${node.label}`)}`,
    "disable-model-invocation: true",
  ].join("\n");
  const expected =
    expectedOutput === undefined || expectedOutput.trim() === ""
      ? []
      : [`Expected output: ${expectedOutput}`];
  const body = [
    "@unfilled: the build agents replace this draft with the finished step skill.",
    fillVariables(instructions, values),
    ...expected,
    "## Builds on",
    handoffFolderLine(scope.repo),
    orNone(handoffText({ given: wired.given, writes: [] })),
    "## Leaves behind",
    orNone(handoffText({ given: [], writes: wired.writes })),
  ].join("\n\n");
  return {
    path: `plugin/skills/${piece}/SKILL.md`,
    content: `---\n${frontmatter}\n---\n${body}\n`,
  };
}
