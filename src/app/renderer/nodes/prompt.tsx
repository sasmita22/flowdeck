import type { NodeProps } from "@xyflow/react";
import { BODY_HEIGHT, Label, NodeShape, roundedRect, TagPill, type ShapeNode } from "./shape.js";

const outline = roundedRect(170, BODY_HEIGHT, 4);
const padL = 8;

export function PromptNode({ id, data, selected }: NodeProps<ShapeNode>) {
  return (
    <NodeShape
      id={id}
      type="prompt"
      selected={selected}
      highlighted={data.highlighted}
      outline={outline}
      padL={padL}
    >
      <TagPill type="prompt" padL={padL} />
      <Label type="prompt" padL={padL} text={data.label} />
    </NodeShape>
  );
}
