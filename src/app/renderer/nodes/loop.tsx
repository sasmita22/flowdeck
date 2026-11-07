import type { NodeProps } from "@xyflow/react";
import { containerText, nodeWidth } from "../canvas/frames.js";
import { nodeLook } from "./look.js";
import { nodeOutline } from "./outlines.js";
import { NodeShape, type ShapeNode } from "./shape.js";

export function LoopNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { group } = nodeLook("loop");
  const text = containerText("loop", data.label ?? "", data.sub);
  return (
    <NodeShape
      id={id}
      type="loop"
      selected={selected}
      highlighted={data.highlighted}
      width={nodeWidth({ type: "loop", label: data.label ?? "", sub: data.sub })}
      overlay={
        <text
          x={nodeOutline("loop").padL}
          y={20}
          fill={group}
          style={{ font: "600 11px var(--f-mono)", letterSpacing: "0.04em", whiteSpace: "pre" }}
        >
          {text}
        </text>
      }
    >
      {null}
    </NodeShape>
  );
}
