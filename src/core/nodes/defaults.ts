import type { Node, NodeType } from "../flow/schema.js";
import * as agentDefaults from "./agent/defaults.js";
import * as askDefaults from "./ask/defaults.js";
import * as branchDefaults from "./branch/defaults.js";
import * as foreachDefaults from "./foreach/defaults.js";
import * as forkDefaults from "./fork/defaults.js";
import * as gateDefaults from "./gate/defaults.js";
import * as hardstopDefaults from "./hardstop/defaults.js";
import * as joinDefaults from "./join/defaults.js";
import * as loopDefaults from "./loop/defaults.js";
import * as outputDefaults from "./output/defaults.js";
import * as promptDefaults from "./prompt/defaults.js";
import * as scriptDefaults from "./script/defaults.js";
import * as triggerDefaults from "./trigger/defaults.js";

type SettingsOf<T extends NodeType> = Extract<Node, { type: T }>["settings"];

export const nodeDefaults: { [T in NodeType]: { label: string; settings: SettingsOf<T> } } = {
  prompt: { label: promptDefaults.defaultLabel, settings: promptDefaults.defaultSettings },
  script: { label: scriptDefaults.defaultLabel, settings: scriptDefaults.defaultSettings },
  agent: { label: agentDefaults.defaultLabel, settings: agentDefaults.defaultSettings },
  gate: { label: gateDefaults.defaultLabel, settings: gateDefaults.defaultSettings },
  ask: { label: askDefaults.defaultLabel, settings: askDefaults.defaultSettings },
  hardstop: { label: hardstopDefaults.defaultLabel, settings: hardstopDefaults.defaultSettings },
  loop: { label: loopDefaults.defaultLabel, settings: loopDefaults.defaultSettings },
  trigger: { label: triggerDefaults.defaultLabel, settings: triggerDefaults.defaultSettings },
  output: { label: outputDefaults.defaultLabel, settings: outputDefaults.defaultSettings },
  fork: { label: forkDefaults.defaultLabel, settings: forkDefaults.defaultSettings },
  join: { label: joinDefaults.defaultLabel, settings: joinDefaults.defaultSettings },
  foreach: { label: foreachDefaults.defaultLabel, settings: foreachDefaults.defaultSettings },
  branch: { label: branchDefaults.defaultLabel, settings: branchDefaults.defaultSettings },
};
