import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function HardstopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="hardstop"
      selected={selected}
      highlighted={data.highlighted}
      width={nodeWidth({ type: "hardstop", label: data.label ?? "" })}
    >
      <TagPill type="hardstop" />
      <Label type="hardstop" text={data.label} />
    </NodeShape>
  );
}
