import type { NodeProps } from "@xyflow/react";
import { nodeTitle } from "../canvas/palette-items.js";
import { nodeLook } from "./look.js";
import { barLook } from "./outlines.js";
import { NodeFailureReason, NodeIssueMarker, NodeStatusBadge } from "../canvas/status.js";
import { ports, tagTextStyle, type ShapeNode } from "./shape.js";

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
    <rect
      width={w}
      height={h}
      rx={barLook.rx}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );
  return (
    <div
      className="fd-node"
      data-testid={`node-${id}`}
      data-highlighted={data.highlighted === true ? "true" : undefined}
      title={nodeTitle(type)}
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
          rx={barLook.rx}
          fill={group}
          fillOpacity={barLook.fillOpacity}
          stroke={outline}
          strokeWidth={barLook.strokeWidth}
        />
        <text
          x={w / 2}
          y={h / 2}
          fill={group}
          textAnchor="middle"
          dominantBaseline="central"
          transform={`rotate(-90 ${w / 2} ${h / 2})`}
          style={tagTextStyle}
        >
          {tag}
        </text>
      </svg>
      <div
        style={{
          position: "absolute",
          bottom: "100%",
          left: "50%",
          transform: "translateX(-50%)",
          marginBottom: 6,
          maxWidth: 170,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg)",
          font: "600 13px var(--f-body)",
        }}
      >
        {data.label}
      </div>
      <div
        style={{
          position: "absolute",
          top: "100%",
          left: "50%",
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          color: "var(--fg)",
        }}
      >
        <NodeStatusBadge nodeId={id} />
        <NodeFailureReason
          nodeId={id}
          style={{ left: "50%", transform: "translateX(-50%)", width: 160, textAlign: "center" }}
        />
      </div>
      <NodeIssueMarker nodeId={id} />
      {ports(id, type)}
    </div>
  );
}
