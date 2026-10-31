import type { NodeProps } from "@xyflow/react";
import { ParallelBar } from "./bar.js";
import type { ShapeNode } from "./shape.js";

export function JoinNode(props: NodeProps<ShapeNode>) {
  return <ParallelBar {...props} type="join" />;
}
