import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function AskNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="ask" selected={selected} highlighted={data.highlighted}>
      <TagPill type="ask" />
      <Label type="ask" text={data.label} />
    </NodeShape>
  );
}
