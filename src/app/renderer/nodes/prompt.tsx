import type { NodeProps } from "@xyflow/react";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function PromptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape id={id} type="prompt" selected={selected} highlighted={data.highlighted}>
      <TagPill type="prompt" />
      <Label type="prompt" text={data.label} />
    </NodeShape>
  );
}
