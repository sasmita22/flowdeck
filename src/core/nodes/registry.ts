import type { z } from "zod";
import type { NodeType, Port } from "../flow/schema.js";
import { ports as agentPorts } from "./agent/ports.js";
import { settings as agentSettings } from "./agent/settings.js";
import { ports as askPorts } from "./ask/ports.js";
import { settings as askSettings } from "./ask/settings.js";
import { ports as foreachPorts } from "./foreach/ports.js";
import { settings as foreachSettings } from "./foreach/settings.js";
import { ports as forkPorts } from "./fork/ports.js";
import { settings as forkSettings } from "./fork/settings.js";
import { ports as gatePorts } from "./gate/ports.js";
import { settings as gateSettings } from "./gate/settings.js";
import { ports as hardstopPorts } from "./hardstop/ports.js";
import { settings as hardstopSettings } from "./hardstop/settings.js";
import { ports as joinPorts } from "./join/ports.js";
import { settings as joinSettings } from "./join/settings.js";
import { ports as loopPorts } from "./loop/ports.js";
import { settings as loopSettings } from "./loop/settings.js";
import { ports as outputPorts } from "./output/ports.js";
import { settings as outputSettings } from "./output/settings.js";
import { ports as promptPorts } from "./prompt/ports.js";
import { settings as promptSettings } from "./prompt/settings.js";
import { ports as scriptPorts } from "./script/ports.js";
import { settings as scriptSettings } from "./script/settings.js";
import { ports as triggerPorts } from "./trigger/ports.js";
import { settings as triggerSettings } from "./trigger/settings.js";

export type NodeDefinition = { settings: z.ZodType; ports: readonly Port[] };

export const registry = {
  prompt: { settings: promptSettings, ports: promptPorts },
  script: { settings: scriptSettings, ports: scriptPorts },
  agent: { settings: agentSettings, ports: agentPorts },
  gate: { settings: gateSettings, ports: gatePorts },
  ask: { settings: askSettings, ports: askPorts },
  hardstop: { settings: hardstopSettings, ports: hardstopPorts },
  loop: { settings: loopSettings, ports: loopPorts },
  trigger: { settings: triggerSettings, ports: triggerPorts },
  output: { settings: outputSettings, ports: outputPorts },
  fork: { settings: forkSettings, ports: forkPorts },
  join: { settings: joinSettings, ports: joinPorts },
  foreach: { settings: foreachSettings, ports: foreachPorts },
} satisfies Record<NodeType, NodeDefinition>;
