import { z } from "zod";
import { decidedByValue } from "../nodes/branch/settings.js";
import { mainFlowOnly } from "./main-flow.js";
import type { Flow } from "./schema.js";

export type VariableValues = Readonly<Record<string, string | boolean>>;

export const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const reference = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const isVariableName = (name: string): boolean => safeName.test(name);

export const referencedVariables = (text: string): string[] => [
  ...new Set(Array.from(text.matchAll(reference), ([, name]) => name ?? "")),
];

export const fillVariables = (text: string, values: VariableValues): string =>
  text.replace(reference, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });

export const FoundVariable = z.object({
  name: z.string(),
  kind: z.enum(["yes-no", "text"]),
  nodeIds: z.tuple([z.string()]).rest(z.string()),
});

export type FoundVariable = z.infer<typeof FoundVariable>;

export function foundVariables(flow: Flow): FoundVariable[] {
  const found = new Map<string, FoundVariable>();
  const add = (name: string, kind: FoundVariable["kind"], nodeId: string) => {
    const key = JSON.stringify([name, kind]);
    const entry = found.get(key);
    if (entry === undefined) found.set(key, { name, kind, nodeIds: [nodeId] });
    else if (!entry.nodeIds.includes(nodeId)) entry.nodeIds.push(nodeId);
  };
  for (const node of mainFlowOnly(flow).nodes) {
    if (node.type === "branch" && !decidedByValue(node.settings) && node.settings.variable !== "") {
      add(node.settings.variable, "yes-no", node.id);
    }
    if (node.type === "agent") {
      for (const name of referencedVariables(node.settings.instructions))
        add(name, "text", node.id);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
