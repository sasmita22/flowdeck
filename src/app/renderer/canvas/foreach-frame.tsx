import type { Node, NodeProps } from "@xyflow/react";
import { FrameRect, ignoredMarks } from "../nodes/shape.js";

type ForEachFrameNode = Node<{ forEachId?: string; ignored?: boolean }>;

export function ForEachFrame({ data, width, height }: NodeProps<ForEachFrameNode>) {
  return (
    <div
      {...ignoredMarks(data.ignored)}
      data-testid={`foreach-frame-${data.forEachId ?? ""}`}
      style={{ position: "relative", width, height }}
    >
      <FrameRect width={width} height={height} color="var(--c-ctrl)" dashed />
    </div>
  );
}
