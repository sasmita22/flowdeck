import type { Flow } from "./schema.js";

export const labelOf = (flow: Flow, id: string): string => {
  const label = flow.nodes.find((node) => node.id === id)?.label.trim() ?? "";
  return label === "" ? id : label;
};
