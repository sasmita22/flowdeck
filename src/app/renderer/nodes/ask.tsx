import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT as h, Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

const w = 170;
const outline = `M8,0 H${w - 8} Q${w},0 ${w},8 V${h - 8} Q${w},${h} ${w - 8},${h} H28 L16,${h + 9} L18,${h} H8 Q0,${h} 0,${h - 8} V8 Q0,0 8,0 Z`;
const padL = 8;

export function AskNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="ask"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
    >
      <TagPill type="ask" padL={padL} />
      <Label type="ask" padL={padL} text={data.label} />
    </NodeShape>
  );
}
