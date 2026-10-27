import type { Node } from "../../flow/schema.js";

export function compilePrompt(node: Extract<Node, { type: "prompt" }>): {
  path: string;
  content: string;
} {
  return {
    path: `commands/${node.id}.md`,
    content: `---\ndescription: ${JSON.stringify(node.label)}\n---\n${node.settings.instructions}\n`,
  };
}
