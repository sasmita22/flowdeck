import type { Node } from "../../flow/schema.js";

const fileLine = (lead: string, files: readonly string[] | undefined) =>
  files === undefined || files.length === 0 ? [] : [`${lead}: ${files.join(", ")}`];

export function compileAgent(node: Extract<Node, { type: "agent" }>): {
  path: string;
  content: string;
} {
  const { role, instructions, model, tools, given, writes } = node.settings;
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
  const files = [...fileLine("You are given", given), ...fileLine("Write", writes)];
  const handoff = files.length === 0 ? "" : `\n${files.join("\n")}\n`;
  return {
    path: `agents/${node.id}.md`,
    content: `---\n${frontmatter}---\n${instructions}\n${handoff}`,
  };
}
