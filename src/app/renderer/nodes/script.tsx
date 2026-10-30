import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT, Label, NodeShape, roundedRect, TagPill, type ShapeNode } from "./shape.js";

const outline = roundedRect(170, BODY_HEIGHT, 6);
const padL = 8;
const ink = "var(--term-fg)";

export function ScriptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="script"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
      fill="var(--term-bg)"
      strokeWidth={1}
      textColor={ink}
    >
      <TagPill type="script" padL={padL} color={ink} />
      <Label type="script" padL={padL} text={data.label} mono color={ink} />
    </NodeShape>
  );
}
