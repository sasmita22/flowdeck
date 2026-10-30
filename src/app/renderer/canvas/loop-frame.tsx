import type { Node, NodeProps } from "@xyflow/react";
import { FrameRect } from "../nodes/shape.js";

type LoopFrameNode = Node<{ loopId?: string }>;

export function LoopFrame({ data, width, height }: NodeProps<LoopFrameNode>) {
  return (
    <div
      className="fd-node"
      data-testid={`loop-frame-${data.loopId ?? ""}`}
      style={{ position: "relative", width, height, pointerEvents: "none" }}
    >
      <FrameRect width={width} height={height} color="var(--c-ctrl)" dashed />
    </div>
  );
}
