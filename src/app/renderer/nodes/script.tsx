import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function ScriptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="script" selected={selected} highlighted={data.highlighted}>
      <TagPill type="script" />
      <Label type="script" text={data.label} />
    </NodeShape>
  );
}
