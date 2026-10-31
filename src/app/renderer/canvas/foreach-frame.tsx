import type { Node, NodeProps } from "@xyflow/react";
import { FrameRect } from "../nodes/shape.js";

type ForEachFrameNode = Node<{ forEachId?: string }>;

export function ForEachFrame({ data, width, height }: NodeProps<ForEachFrameNode>) {
  return (
    <div
      className="fd-node"
      data-testid={`foreach-frame-${data.forEachId ?? ""}`}
      style={{ position: "relative", width, height, pointerEvents: "none" }}
    >
      <FrameRect width={width} height={height} color="var(--c-ctrl)" dashed />
    </div>
  );
}
