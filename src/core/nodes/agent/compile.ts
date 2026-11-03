import { handoffText, type Handoff } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { fillVariables, type VariableValues } from "../../flow/variables.js";

export function compileAgent(
  node: Extract<Node, { type: "agent" }>,
  wired: Handoff = { given: [], writes: [] },
  values: VariableValues = {},
): {
  path: string;
  content: string;
} {
  const { role, instructions, model, tools, given = [], writes = [] } = node.settings;
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
  const handoff = handoffText({
    given: [...given, ...wired.given],
    writes: [...writes, ...wired.writes],
  });
  return {
    path: `plugin/agents/${node.id}.md`,
    content: `---\n${frontmatter}---\n${fillVariables(instructions, values)}\n${handoff}`,
  };
}
