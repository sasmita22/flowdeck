import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function GateNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="gate" selected={selected} highlighted={data.highlighted}>
      <TagPill type="gate" />
      <Label type="gate" text={data.label} />
    </NodeShape>
  );
}
