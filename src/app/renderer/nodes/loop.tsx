import type { NodeProps } from "@xyflow/react";
import { nodeLook } from "./look.js";
import { nodeOutline } from "./outlines.js";
import { NodeShape, type ShapeNode } from "./shape.js";

export function LoopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { tag, group } = nodeLook("loop");
  return (
    <NodeShape id={id} type="loop" selected={selected} highlighted={data.highlighted}>
      <text
        x={nodeOutline("loop").padL}
        y={20}
        fill={group}
        style={{ font: "600 11px var(--f-mono)", letterSpacing: "0.04em" }}
      >
        {`${tag} · ${data.label ?? ""}`}
      </text>
    </NodeShape>
  );
}
