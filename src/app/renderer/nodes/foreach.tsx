import type { NodeProps } from "@xyflow/react";
import { containerText, nodeWidth } from "../canvas/frames.js";
import { nodeLook } from "./look.js";
import { nodeOutline } from "./outlines.js";
import { NodeShape, type ShapeNode } from "./shape.js";

export function ForEachNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const { group } = nodeLook("foreach");
  const text = containerText("foreach", data.label ?? "", data.sub);
  return (
    <NodeShape
      id={id}
      type="foreach"
      selected={selected}
      highlighted={data.highlighted}
      width={nodeWidth({ type: "foreach", label: data.label ?? "", sub: data.sub })}
      overlay={
        <text
          x={nodeOutline("foreach").padL}
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
