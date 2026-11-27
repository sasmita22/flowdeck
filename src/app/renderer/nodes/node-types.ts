import type { NodeTypes } from "@xyflow/react";
import { ContainerFrame } from "../canvas/container-frame.js";
import { LoopFrame } from "../canvas/loop-frame.js";
import { AgentNode } from "./agent.js";
import { BranchNode } from "./branch.js";
import { ForkNode } from "./fork.js";
import { GateNode } from "./gate.js";
import { JoinNode } from "./join.js";
import { LibraryNode } from "./library.js";
import { LoopNode } from "./loop.js";
import { NoteNode } from "./note.js";
import { OutputNode } from "./output.js";
import { TriggerNode } from "./trigger.js";

export const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  gate: GateNode,
  loop: LoopNode,
  fork: ForkNode,
  join: JoinNode,
  branch: BranchNode,
  library: LibraryNode,
  output: OutputNode,
  "loop-frame": LoopFrame,
  "container-frame": ContainerFrame,
  note: NoteNode,
};
