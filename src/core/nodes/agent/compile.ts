import type { Node } from "../../flow/schema.js";

export function compileAgent(node: Extract<Node, { type: "agent" }>): {
  path: string;
  content: string;
} {
  const { role, instructions, model, tools } = node.settings;
  const fields: [string, string | undefined][] = [
    ["name", node.id],
    ["description", role === "" ? node.label : role],
    ["tools", tools.length > 0 ? tools.join(", ") : undefined],
    ["model", model === "" ? undefined : model],
  ];
  const frontmatter = fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
    .join("");
  return { path: `agents/${node.id}.md`, content: `---\n${frontmatter}---\n${instructions}\n` };
}
