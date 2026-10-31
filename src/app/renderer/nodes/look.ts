import type { NodeType, Port } from "../../../core/flow/schema.js";
import { registry } from "../../../core/nodes/registry.js";

export interface NodeLook {
  tag: string;
  group: string;
  outline: string;
  box: { width: number; height: number };
  ports: readonly Port[];
}

const io = "var(--c-io)";
const work = "var(--c-work)";
const human = "var(--c-human)";
const ctrl = "var(--c-ctrl)";
const line = "var(--line)";

const box = { width: 170, height: 48 };

const look = (
  type: NodeType,
  tag: string,
  group: string,
  outline: string,
  height = box.height,
  width = box.width,
) => ({
  tag,
  group,
  outline,
  box: { width, height },
  ports: registry[type].ports,
});

const looks: Record<NodeType, NodeLook> = {
  trigger: look("trigger", "TRG", io, io),
  output: look("output", "OUT", io, io),
  prompt: look("prompt", "STP", work, line),
  agent: look("agent", "AGT", work, work),
  script: look("script", "SH", work, "var(--term-bg)"),
  gate: look("gate", "GATE", human, line),
  hardstop: look("hardstop", "STOP", human, human),
  ask: look("ask", "ASK", human, human, 57),
  loop: look("loop", "LOOP", ctrl, "none"),
  fork: look("fork", "PARALLEL START", ctrl, ctrl, box.height, 28),
  join: look("join", "PARALLEL END", ctrl, ctrl, box.height, 28),
  foreach: look("foreach", "EACH", ctrl, "none"),
};

export const nodeLook = (type: NodeType): NodeLook => looks[type];
