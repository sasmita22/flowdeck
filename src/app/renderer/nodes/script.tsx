import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function ScriptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="script"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={nodeWidth({ type: "script", label: data.label ?? "" })}
    >
      <TagPill type="script" />
      <Label type="script" text={data.label} />
    </NodeShape>
  );
}
