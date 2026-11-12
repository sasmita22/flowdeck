import { scopeLine, type ScopeParts } from "../../compiler/scope-line.js";
import { declaredHandoff, handoffFolderLine, handoffText } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { fillVariables, type VariableValues } from "../../flow/variables.js";

export type AgentCompileInputs = {
  piece: string;
  scope: ScopeParts;
  values?: VariableValues;
};

const orNone = (text: string) => (text.trim() === "" ? "None." : text.trim());

export function compileAgent(
  node: Extract<Node, { type: "agent" }>,
  inputs: AgentCompileInputs,
): {
  path: string;
  content: string;
} {
  const { piece, scope, values = {} } = inputs;
  const { role, instructions, model, tools } = node.settings;
  const { given, writes } = declaredHandoff(node.settings);
  const draft = role === "" ? node.label : role;
  const fields: [string, string | undefined][] = [
    ["name", piece],
    ["description", `${scopeLine(scope)} ${draft}`],
    ["tools", tools.length > 0 ? tools.join(", ") : undefined],
    ["model", model === "" ? undefined : model],
  ];
  const frontmatter = fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
    .join("");
  const body = [
    "@unfilled: the build agents replace this draft with the finished agent.",
    "## Role",
    draft,
    "## Inputs",
    handoffFolderLine(scope.repo),
    orNone(handoffText({ given, writes: [] })),
    "## Steps",
    fillVariables(instructions, values),
    "## Output",
    orNone(handoffText({ given: [], writes })),
    "## When to stop",
    "Stop once the output is written.",
  ].join("\n\n");
  return {
    path: `plugin/agents/${piece}.md`,
    content: `---\n${frontmatter}---\n${body}\n`,
  };
}
