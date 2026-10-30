import type { Node, NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import { FrameRect } from "../nodes/shape.js";

type FrameNode = Node<{ name: string }>;

const color = "var(--c-hub)";

const labelStyle: CSSProperties = {
  position: "absolute",
  top: 6,
  left: 12,
  color,
  font: "600 11px var(--f-mono)",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

export function SessionFrame({ data, width, height }: NodeProps<FrameNode>) {
  return (
    <div
      className="fd-node"
      data-testid="session-frame"
      style={{ position: "relative", width, height, pointerEvents: "none" }}
    >
      <FrameRect width={width} height={height} color={color} dashed={false} />
      <span style={labelStyle}>
        SESS · <span data-testid="session-frame-name">{data.name}</span>
      </span>
    </div>
  );
}
