import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function OutputNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="output" selected={selected} highlighted={data.highlighted}>
      <TagPill type="output" />
      <Label type="output" text={data.label} />
    </NodeShape>
  );
}
