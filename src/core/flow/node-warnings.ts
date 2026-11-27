import type { Node } from "./schema.js";

const alwaysGateSkipped =
  "This Gate is skipped in automatic runs and auto mode: it pauses only manual runs.";

export const nodeWarnings = (node: Node): string[] =>
  node.type === "gate" && node.settings.stopWhen === "always" ? [alwaysGateSkipped] : [];
