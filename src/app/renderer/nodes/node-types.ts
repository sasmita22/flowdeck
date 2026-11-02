import type { NodeTypes } from "@xyflow/react";
import { ForEachFrame } from "../canvas/foreach-frame.js";
import { LoopFrame } from "../canvas/loop-frame.js";
import { AgentNode } from "./agent.js";
import { AskNode } from "./ask.js";
import { BranchNode } from "./branch.js";
import { ForEachNode } from "./foreach.js";
import { ForkNode } from "./fork.js";
import { GateNode } from "./gate.js";
import { HardstopNode } from "./hardstop.js";
import { JoinNode } from "./join.js";
import { LoopNode } from "./loop.js";
import { NoteNode } from "./note.js";
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
  foreach: ForEachNode,
  fork: ForkNode,
  join: JoinNode,
  branch: BranchNode,
  output: OutputNode,
  "loop-frame": LoopFrame,
  "foreach-frame": ForEachFrame,
  note: NoteNode,
};
