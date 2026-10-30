import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT, NodeShape, roundedRect, type ShapeNode } from "./shape.js";
import { nodeLook } from "./look.js";

const outline = roundedRect(170, BODY_HEIGHT, 4);
const padL = 8;

export function LoopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { tag, group } = nodeLook("loop");
  return (
    <NodeShape
      id={id}
      type="loop"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
      fill="none"
    >
      <text
        x={padL}
        y={20}
        fill={group}
        style={{ font: "600 11px var(--f-mono)", letterSpacing: "0.04em" }}
      >
        {`${tag} · ${data.label ?? ""}`}
      </text>
    </NodeShape>
  );
}
