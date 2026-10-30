import type { Node, NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";

type FrameNode = Node<{ name: string }>;

const frameStyle: CSSProperties = {
  boxSizing: "border-box",
  border: "1.5px dashed #6b7280",
  borderRadius: 8,
  background: "rgba(107, 114, 128, 0.06)",
  pointerEvents: "none",
};

const labelStyle: CSSProperties = {
  position: "absolute",
  top: -18,
  left: 0,
  fontFamily: "system-ui, sans-serif",
  fontSize: 11,
  color: "#4b5563",
};

export function SessionFrame({ data, width, height }: NodeProps<FrameNode>) {
  return (
    <div data-testid="session-frame" style={{ ...frameStyle, width, height }}>
      <span data-testid="session-frame-name" style={labelStyle}>
        {data.name}
      </span>
    </div>
  );
}
