import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT as h, Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

const w = 170;
const r = h / 2;
const outline = `M${r},0 H${w - 6} Q${w},0 ${w},6 V${h - 6} Q${w},${h} ${w - 6},${h} H${r} A${r},${r} 0 0 1 ${r},0 Z`;
const padL = 16;

export function TriggerNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="trigger"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
    >
      <TagPill type="trigger" padL={padL} />
      <Label type="trigger" padL={padL} text={data.label} />
    </NodeShape>
  );
}
