import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT as h, Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

const w = 170;
const r = h / 2;
const outline = `M6,0 H${w - r} A${r},${r} 0 0 1 ${w - r},${h} H6 Q0,${h} 0,${h - 6} V6 Q0,0 6,0 Z`;
const padL = 8;

export function OutputNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="output"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
    >
      <TagPill type="output" padL={padL} />
      <Label type="output" padL={padL} text={data.label} />
    </NodeShape>
  );
}
