import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function AgentNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="agent"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={nodeWidth({ type: "agent", label: data.label ?? "" })}
    >
      <TagPill type="agent" />
      <Label type="agent" text={data.label} />
    </NodeShape>
  );
}
