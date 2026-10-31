import type { NodeProps } from "@xyflow/react";
import { nodeLook } from "./look.js";
import { ports, type ShapeNode } from "./shape.js";

export function ParallelBar({
  id,
  type,
  data,
  selected,
  width,
  height,
}: Pick<NodeProps<ShapeNode>, "id" | "data" | "selected" | "width" | "height"> & {
  type: "fork" | "join";
}) {
  const { box, group, outline, tag } = nodeLook(type);
  const [w, h] = [width ?? box.width, height ?? box.height];
  const ring = (stroke: string, strokeWidth: number) => (
    <rect width={w} height={h} rx={8} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
  );
  return (
    <div
      className="fd-node"
      data-testid={`node-${id}`}
      data-highlighted={data.highlighted === true ? "true" : undefined}
      style={{ position: "relative", width: w, height: h }}
    >
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, display: "block", overflow: "visible" }}
      >
        {data.highlighted === true && ring("var(--ring)", 8)}
        {selected && ring("var(--select)", 5)}
        <rect
          className="fd-node-outline"
          width={w}
          height={h}
          rx={8}
          fill={group}
          fillOpacity={0.16}
          stroke={outline}
          strokeWidth={1.4}
        />
        <text
          x={w / 2}
          y={h / 2}
          fill={group}
          textAnchor="middle"
          dominantBaseline="central"
          transform={`rotate(-90 ${w / 2} ${h / 2})`}
          style={{ font: "600 9.5px var(--f-mono)", letterSpacing: "0.04em" }}
        >
          {tag}
        </text>
      </svg>
      {ports(id, type)}
    </div>
  );
}
