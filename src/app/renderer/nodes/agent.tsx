import type { NodeProps } from "@xyflow/react";
import { nodeWidth } from "../canvas/frames.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";
import { useFirstWarning, WarningMarker } from "./warning-marker.js";

export function AgentNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const warning = useFirstWarning(id);
  const width = nodeWidth({ type: "agent", label: data.label ?? "" });
  return (
    <NodeShape
      id={id}
      type="agent"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={width}
      overlay={warning === undefined ? undefined : <WarningMarker x={width} text={warning} />}
    >
      <TagPill type="agent" />
      <Label type="agent" text={data.label} />
    </NodeShape>
  );
}
