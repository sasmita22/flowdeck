import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT, Label, NodeShape, octagon, TagPill, type ShapeNode } from "./shape.js";
import { nodeLook } from "./look.js";

const outline = octagon(170, BODY_HEIGHT, 13);
const padL = 12;

export function HardstopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="hardstop"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
      strokeWidth={2}
    >
      <path d={outline} fill={nodeLook("hardstop").group} fillOpacity={0.14} />
      <TagPill type="hardstop" padL={padL} />
      <Label type="hardstop" padL={padL} text={data.label} />
    </NodeShape>
  );
}
