import { scopeLine, type ScopeParts } from "../../compiler/scope-line.js";
import { handoffFolderLine } from "../../flow/handoff.js";
import type { Node } from "../../flow/schema.js";
import { fillVariables, type VariableValues } from "../../flow/variables.js";

type AgentCompileInputs = {
  piece: string;
  scope: ScopeParts;
  values?: VariableValues;
};

export function compileAgent(
  node: Extract<Node, { type: "agent" }>,
  inputs: AgentCompileInputs,
): {
  path: string;
  content: string;
} {
  const { piece, scope, values = {} } = inputs;
  const { role, instructions, model } = node.settings;
  const draft = role === "" ? node.label : role;
  const fields: [string, string | undefined][] = [
    ["name", piece],
    ["description", `${scopeLine(scope)} ${draft}`],
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
    handoffFolderLine(scope.repo, scope.kind),
    "## Steps",
    fillVariables(instructions, values),
    "## Output",
    "## When to stop",
    "Stop once the output is written.",
  ].join("\n\n");
  return {
    path: `plugin/agents/${piece}.md`,
    content: `---\n${frontmatter}---\n${body}\n`,
  };
}
