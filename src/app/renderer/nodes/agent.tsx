import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT, Label, NodeShape, roundedRect, TagPill, type ShapeNode } from "./shape.js";
import { nodeLook } from "./look.js";

const outline = roundedRect(170, BODY_HEIGHT, 12);
const innerRing = roundedRect(170, BODY_HEIGHT, 9, 3.5);
const padL = 10;

export function AgentNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="agent"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
      strokeWidth={1.6}
    >
      <path d={innerRing} fill="none" stroke={nodeLook("agent").group} strokeOpacity={0.4} />
      <TagPill type="agent" padL={padL} />
      <Label type="agent" padL={padL} text={data.label} />
    </NodeShape>
  );
}
