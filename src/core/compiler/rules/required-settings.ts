import type { Node } from "../../flow/schema.js";
import type { Rule, ValidationError } from "../validate.js";

const id = "required-settings";

export const agentPlaceholder = "Describe the agent's task.";

const required: Partial<Record<Node["type"], { field: string; message: string }>> = {
  agent: { field: "instructions", message: "Write what the agent should do." },
  loop: { field: "condition", message: "Write when the loop is done." },
  ask: { field: "question", message: "Write the question to ask." },
};

const blank = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" || text === agentPlaceholder;
};

export const rule: Rule = {
  id,
  message: "Agents need instructions, Loops a condition and Asks a question.",
  check: (flow) =>
    flow.nodes.flatMap((node): ValidationError[] => {
      const need = required[node.type];
      if (need === undefined) return [];
      const value = (node.settings as Record<string, unknown>)[need.field];
      return blank(value)
        ? [{ rule: id, node: node.id, field: need.field, message: need.message }]
        : [];
    }),
};
