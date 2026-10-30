import type { NodeProps } from "@xyflow/react";
import {
  BODY_HEIGHT as h,
  Label,
  NodeShape,
  roundedRect,
  TagPill,
  type ShapeNode,
} from "./shape.js";
import { nodeLook } from "./look.js";

const w = 170;
const outline = roundedRect(w, h, 3);
const padL = 12;

export function GateNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const post = nodeLook("gate").group;
  return (
    <NodeShape
      id={id}
      type="gate"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
      strokeWidth={1}
    >
      <rect x={0} y={0} width={5} height={h} rx={2} fill={post} />
      <rect x={w - 5} y={0} width={5} height={h} rx={2} fill={post} />
      <TagPill type="gate" padL={padL} />
      <Label type="gate" padL={padL} text={data.label} />
    </NodeShape>
  );
}
