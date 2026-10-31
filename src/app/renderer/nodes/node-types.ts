import type { NodeTypes } from "@xyflow/react";
import { LoopFrame } from "../canvas/loop-frame.js";
import { SessionFrame } from "../canvas/session.js";
import { AgentNode } from "./agent.js";
import { AskNode } from "./ask.js";
import { ForkNode } from "./fork.js";
import { GateNode } from "./gate.js";
import { HardstopNode } from "./hardstop.js";
import { JoinNode } from "./join.js";
import { LoopNode } from "./loop.js";
import { OutputNode } from "./output.js";
import { PromptNode } from "./prompt.js";
import { ScriptNode } from "./script.js";
import { TriggerNode } from "./trigger.js";

export const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  prompt: PromptNode,
  agent: AgentNode,
  script: ScriptNode,
  gate: GateNode,
  hardstop: HardstopNode,
  ask: AskNode,
  loop: LoopNode,
  fork: ForkNode,
  join: JoinNode,
  output: OutputNode,
  session: SessionFrame,
  "loop-frame": LoopFrame,
};
