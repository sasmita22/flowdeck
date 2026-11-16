import type { NodeProps } from "@xyflow/react";
import { sideLabelSpan } from "../canvas/frames.js";
import { NodeShape, SideLabel, type ShapeNode } from "./shape.js";

export function OutputNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="output"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      trailing={sideLabelSpan(data.label ?? "")}
      overlay={<SideLabel type="output" text={data.label} />}
    >
      {null}
    </NodeShape>
  );
}
