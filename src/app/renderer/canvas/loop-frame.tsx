import type { Node, NodeProps } from "@xyflow/react";
import { FrameRect, ignoredMarks } from "../nodes/shape.js";

type LoopFrameNode = Node<{ loopId?: string; ignored?: boolean }>;

export function LoopFrame({ data, width, height }: NodeProps<LoopFrameNode>) {
  return (
    <div
      {...ignoredMarks(data.ignored)}
      data-testid={`loop-frame-${data.loopId ?? ""}`}
      style={{ position: "relative", width, height }}
    >
      <FrameRect width={width} height={height} color="var(--c-ctrl)" dashed />
    </div>
  );
}
