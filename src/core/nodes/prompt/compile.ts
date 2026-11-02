import type { Node } from "../../flow/schema.js";

export function compilePrompt(node: Extract<Node, { type: "prompt" }>): {
  path: string;
  content: string;
} {
  const { instructions, expectedOutput } = node.settings;
  const expected =
    expectedOutput === undefined || expectedOutput.trim() === ""
      ? ""
      : `\nExpected output: ${expectedOutput}\n`;
  return {
    path: `commands/${node.id}.md`,
    content: `---\ndescription: ${JSON.stringify(node.label)}\n---\n${instructions}\n${expected}`,
  };
}
