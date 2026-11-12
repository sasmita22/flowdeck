import type { Flow } from "./schema.js";

export const labelOf = (flow: Flow, id: string): string => {
  const label = flow.nodes.find((node) => node.id === id)?.label.trim() ?? "";
  return label === "" ? id : label;
};

export const labelsOf = (flow: Flow, ids: readonly string[]): string =>
  ids.map((id) => labelOf(flow, id)).join(", ");
