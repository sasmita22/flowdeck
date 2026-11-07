import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function OutputNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="output"
      selected={selected}
      highlighted={data.highlighted}
      width={nodeWidth({ type: "output", label: data.label ?? "" })}
    >
      <TagPill type="output" />
      <Label type="output" text={data.label} />
    </NodeShape>
  );
}
