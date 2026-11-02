import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function TriggerNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="trigger" selected={selected} highlighted={data.highlighted}>
      <TagPill type="trigger" />
      <Label type="trigger" text={data.label} />
    </NodeShape>
  );
}
