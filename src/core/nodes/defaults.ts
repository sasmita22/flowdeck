import type { Node, NodeType } from "../flow/schema.js";
import * as agentDefaults from "./agent/defaults.js";
import * as branchDefaults from "./branch/defaults.js";
import * as forkDefaults from "./fork/defaults.js";
import * as gateDefaults from "./gate/defaults.js";
import * as joinDefaults from "./join/defaults.js";
import * as libraryDefaults from "./library/defaults.js";
import * as loopDefaults from "./loop/defaults.js";
import * as outputDefaults from "./output/defaults.js";
import * as triggerDefaults from "./trigger/defaults.js";

type SettingsOf<T extends NodeType> = Extract<Node, { type: T }>["settings"];

export const nodeDefaults: { [T in NodeType]: { label: string; settings: SettingsOf<T> } } = {
  agent: { label: agentDefaults.defaultLabel, settings: agentDefaults.defaultSettings },
  gate: { label: gateDefaults.defaultLabel, settings: gateDefaults.defaultSettings },
  loop: { label: loopDefaults.defaultLabel, settings: loopDefaults.defaultSettings },
  trigger: { label: triggerDefaults.defaultLabel, settings: triggerDefaults.defaultSettings },
  output: { label: outputDefaults.defaultLabel, settings: outputDefaults.defaultSettings },
  fork: { label: forkDefaults.defaultLabel, settings: forkDefaults.defaultSettings },
  join: { label: joinDefaults.defaultLabel, settings: joinDefaults.defaultSettings },
  branch: { label: branchDefaults.defaultLabel, settings: branchDefaults.defaultSettings },
  library: { label: libraryDefaults.defaultLabel, settings: libraryDefaults.defaultSettings },
};

export const labelFor = (node: Pick<Node, "type" | "label"> | undefined): string => {
  if (node === undefined) return "Build";
  return node.label.trim() === "" ? nodeDefaults[node.type].label : node.label;
};
