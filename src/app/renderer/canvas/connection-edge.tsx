import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { containerTestIds } from "../test-ids.js";
import { connectionOfEdge } from "./view.js";

export function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <BaseEdge
      path={path}
      data-testid={containerTestIds.connection(connectionOfEdge(id))}
      {...(markerStart !== undefined && { markerStart })}
      {...(markerEnd !== undefined && { markerEnd })}
      {...(style !== undefined && { style })}
    />
  );
}
