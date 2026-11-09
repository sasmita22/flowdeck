import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function PromptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="prompt"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={nodeWidth({ type: "prompt", label: data.label ?? "" })}
    >
      <TagPill type="prompt" />
      <Label type="prompt" text={data.label} />
    </NodeShape>
  );
}
