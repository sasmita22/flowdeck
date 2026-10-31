import { BaseEdge, getStraightPath, type Edge, type EdgeProps } from "@xyflow/react";
import { alignedEnds, type Align } from "./view.js";

export function AlignedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<{ align: Align }>>) {
  const ends = { sourceX, sourceY, targetX, targetY };
  const [path] = getStraightPath(data === undefined ? ends : alignedEnds(ends, data.align));
  return <BaseEdge path={path} />;
}
