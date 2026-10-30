import { Handle, Position, type Node } from "@xyflow/react";
import { useId, type ReactNode } from "react";
import type { NodeType } from "../../../core/flow/schema.js";
import { NodeStatusBadge } from "../canvas/status.js";
import { nodeLook } from "./look.js";
import "./tokens.css";

export type ShapeNode = Node<{ label?: string; highlighted?: boolean }>;

export const BODY_HEIGHT = 48;

export const roundedRect = (width: number, height: number, r: number, inset = 0): string => {
  const [x, y, w, h] = [inset, inset, width - 2 * inset, height - 2 * inset];
  return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
};

export const octagon = (w: number, h: number, c: number): string =>
  `M${c},0 H${w - c} L${w},${c} V${h - c} L${w - c},${h} H${c} L0,${h - c} V${c} Z`;

const tagWidth = (tag: string) => tag.length * 7 + 10;

const ports = (id: string, type: NodeType) =>
  nodeLook(type).ports.map(({ name, direction }) => (
    <Handle
      key={name}
      id={name}
      type={direction === "in" ? "target" : "source"}
      position={direction === "in" ? Position.Left : Position.Right}
      style={{ top: BODY_HEIGHT / 2 }}
      data-testid={`port-${id}-${name}`}
    />
  ));

export function NodeShape({
  id,
  type,
  selected,
  highlighted,
  outline,
  padL,
  fill = "var(--panel)",
  strokeWidth = 1.4,
  textColor = "var(--fg)",
  children,
}: {
  id: string;
  type: NodeType;
  selected: boolean;
  highlighted: boolean | undefined;
  outline: string;
  padL: number;
  fill?: string;
  strokeWidth?: number;
  textColor?: string;
  children: ReactNode;
}) {
  const clip = `fd-clip-${useId().replace(/[^\w-]/g, "")}`;
  const { box, outline: stroke } = nodeLook(type);
  return (
    <div
      className="fd-node"
      data-testid={`node-${id}`}
      data-highlighted={highlighted === true ? "true" : undefined}
      style={{ position: "relative", ...box }}
    >
      <svg
        width={box.width}
        height={box.height}
        style={{ position: "absolute", inset: 0, display: "block", overflow: "visible" }}
      >
        <defs>
          <clipPath id={clip}>
            <path d={outline} />
          </clipPath>
        </defs>
        {highlighted === true && (
          <path d={outline} fill="none" stroke="var(--ring)" strokeWidth={8} />
        )}
        {selected && <path d={outline} fill="none" stroke="var(--select)" strokeWidth={5} />}
        <path
          className="fd-node-outline"
          d={outline}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
        <g clipPath={`url(#${clip})`}>{children}</g>
      </svg>
      <div style={{ position: "absolute", left: padL, top: 25, color: textColor }}>
        <NodeStatusBadge nodeId={id} />
      </div>
      {ports(id, type)}
    </div>
  );
}

export function TagPill({ type, padL, color }: { type: NodeType; padL: number; color?: string }) {
  const { tag, group } = nodeLook(type);
  const fill = color ?? group;
  return (
    <>
      <rect
        x={padL}
        y={8}
        width={tagWidth(tag)}
        height={15}
        rx={4}
        fill={fill}
        fillOpacity={0.15}
      />
      <text
        x={padL + 5}
        y={19}
        fill={fill}
        style={{ font: "600 9.5px var(--f-mono)", letterSpacing: "0.04em" }}
      >
        {tag}
      </text>
    </>
  );
}

export function Label({
  type,
  padL,
  text,
  mono = false,
  color = "var(--fg)",
}: {
  type: NodeType;
  padL: number;
  text: string | undefined;
  mono?: boolean;
  color?: string;
}) {
  return (
    <text
      x={padL + tagWidth(nodeLook(type).tag) + 6}
      y={20}
      fill={color}
      style={{ font: mono ? "600 12px var(--f-mono)" : "600 13px var(--f-body)" }}
    >
      {text}
    </text>
  );
}

export function FrameRect({
  width = 0,
  height = 0,
  color,
  dashed,
}: {
  width: number | undefined;
  height: number | undefined;
  color: string;
  dashed: boolean;
}) {
  return (
    <svg
      width={width}
      height={height}
      style={{ position: "absolute", inset: 0, display: "block", overflow: "visible" }}
    >
      <rect
        width={width}
        height={height}
        rx={10}
        fill={color}
        fillOpacity={0.05}
        stroke={color}
        strokeOpacity={0.6}
        strokeWidth={1.4}
        strokeDasharray={dashed ? "6 4" : undefined}
      />
    </svg>
  );
}
