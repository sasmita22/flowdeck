import { handoffText, type Handoff } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { fillVariables, type VariableValues } from "../../flow/variables.js";

export function compilePrompt(
  node: Extract<Node, { type: "prompt" }>,
  wired: Handoff = { given: [], writes: [] },
  values: VariableValues = {},
): {
  path: string;
  content: string;
} {
  const { instructions, expectedOutput } = node.settings;
  const expected =
    expectedOutput === undefined || expectedOutput.trim() === ""
      ? ""
      : `\nExpected output: ${expectedOutput}\n`;
  return {
    path: `plugin/commands/${node.id}.md`,
    content: `---\ndescription: ${JSON.stringify(node.label)}\n---\n${fillVariables(instructions, values)}\n${expected}${handoffText(wired)}`,
  };
}
