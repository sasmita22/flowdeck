import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import { BranchLabel } from "./branch-edge.js";
import { labelPoint, routePath, snapRoute, type Point } from "./wire-route.js";

export function RoutedEdge({
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<Edge<{ points: Point[]; label?: string }>>) {
  const points = snapRoute(data?.points ?? [], { sourceX, sourceY, targetX, targetY });
  const label = data?.label;
  const at = label === undefined ? undefined : labelPoint(points);
  return (
    <>
      <BaseEdge
        path={routePath(points)}
        {...(markerEnd !== undefined && { markerEnd })}
        {...(style !== undefined && { style })}
        {...(interactionWidth !== undefined && { interactionWidth })}
      />
      {label !== undefined && at !== undefined && (
        <BranchLabel x={at.x} y={at.y} source={source} label={label} />
      )}
    </>
  );
}
