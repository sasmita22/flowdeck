import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";
import { useFirstWarning, WarningMarker } from "./warning-marker.js";

export function GateNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const warning = useFirstWarning(id);
  const width = nodeWidth({ type: "gate", label: data.label ?? "" });
  return (
    <NodeShape
      id={id}
      type="gate"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={width}
      overlay={warning === undefined ? undefined : <WarningMarker x={width} text={warning} />}
    >
      <TagPill type="gate" />
      <Label type="gate" text={data.label} />
    </NodeShape>
  );
}
