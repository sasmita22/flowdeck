import type { NodeProps } from "@xyflow/react";
import { nodeLook } from "./look.js";
import { nodeOutline } from "./outlines.js";
import { NodeShape, type ShapeNode } from "./shape.js";

export function ForEachNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { tag, group } = nodeLook("foreach");
  return (
    <NodeShape id={id} type="foreach" selected={selected} highlighted={data.highlighted}>
      <text
        x={nodeOutline("foreach").padL}
        y={20}
        fill={group}
        style={{ font: "600 11px var(--f-mono)", letterSpacing: "0.04em" }}
      >
        {`${tag} · ${data.label ?? ""}`}
      </text>
    </NodeShape>
  );
}
