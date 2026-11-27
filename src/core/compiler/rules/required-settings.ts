import type { Node } from "../../flow/schema.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "required-settings";

export const agentPlaceholder = "Describe the agent's task.";

const required: Partial<Record<Node["type"], { field: string; message: string }[]>> = {
  agent: [{ field: "instructions", message: "Write what the agent should do." }],
  loop: [{ field: "condition", message: "Write when the loop is done." }],
  output: [
    { field: "name", message: "Name the run's output." },
    { field: "type", message: "Write the output's type." },
  ],
};

const blank = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === agentPlaceholder;
};

export const rule: Rule = {
  id,
  message: "Agents need instructions, Loops a condition and Stops an output name and type.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] =>
      (required[node.type] ?? [])
        .filter(({ field }) => blank((node.settings as Record<string, unknown>)[field]))
        .map(({ field, message }) => ({ rule: id, node: node.id, field, message })),
    ),
};
