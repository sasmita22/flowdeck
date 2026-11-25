import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export function BranchLabel({
  x,
  y,
  source,
  label,
}: {
  x: number;
  y: number;
  source: string;
  label: string;
}) {
  return (
    <EdgeLabelRenderer>
      <div
        className="fd-branch-wire-label"
        data-testid={`branch-wire-${source}-${label}`}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  );
}

export function BranchEdge({
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<Edge<{ label: string }>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <>
      <BaseEdge path={path} {...(markerEnd !== undefined && { markerEnd })} />
      <BranchLabel x={labelX} y={labelY} source={source} label={data?.label ?? ""} />
    </>
  );
}
