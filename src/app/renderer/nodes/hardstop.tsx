import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function HardstopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="hardstop" selected={selected} highlighted={data.highlighted}>
      <TagPill type="hardstop" />
      <Label type="hardstop" text={data.label} />
    </NodeShape>
  );
}
