import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function AskNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="ask"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={nodeWidth({ type: "ask", label: data.label ?? "" })}
    >
      <TagPill type="ask" />
      <Label type="ask" text={data.label} />
    </NodeShape>
  );
}
