import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export function FileEdge({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<Edge<{ file: string }>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const file = data?.file ?? "";
  return (
    <>
      <BaseEdge
        path={path}
        className="fd-file-wire"
        style={{ strokeDasharray: "6 4" }}
        {...(markerEnd !== undefined && { markerEnd })}
      />
      <EdgeLabelRenderer>
        <div
          className="fd-file-wire-label"
          data-testid={`file-wire-${source}-${target}-${file}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {file}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
