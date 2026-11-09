import type { NodeProps } from "@xyflow/react";
import { NodeShape, SideLabel, type ShapeNode } from "./shape.js";

export function TriggerNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="trigger"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      overlay={<SideLabel type="trigger" text={data.label} />}
    >
      {null}
    </NodeShape>
  );
}
