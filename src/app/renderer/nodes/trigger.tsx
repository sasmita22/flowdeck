import type { NodeProps } from "@xyflow/react";
import { sideLabelSpan } from "../canvas/frames.js";
import { nodeLook } from "./look.js";
import { NodeShape, ports, SideLabel, type ShapeNode } from "./shape.js";

export function TriggerNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { box } = nodeLook("trigger");
  const span = sideLabelSpan(data.label ?? "");
  return (
    <NodeShape
      id={id}
      type="trigger"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      trailing={span}
      handles={ports(id, "trigger", box.width + span)}
      overlay={<SideLabel type="trigger" text={data.label} />}
    >
      {null}
    </NodeShape>
  );
}
