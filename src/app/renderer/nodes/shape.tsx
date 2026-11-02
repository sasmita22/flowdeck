import { Handle, Position, type Node } from "@xyflow/react";
import { createElement, useId, type ReactNode } from "react";
import type { NodeType } from "../../../core/flow/schema.js";
import { nodeTitle } from "../canvas/palette-items.js";
import { NodeIssueMarker, NodeStatusBadge } from "../canvas/status.js";
import { nodeLook, tagWidth } from "./look.js";
import { frameLook, nodeOutline, type OutlinedType, type ShapeExtra } from "./outlines.js";
import "./tokens.css";

export type ShapeNode = Node<{ label?: string; highlighted?: boolean }>;

export const BODY_HEIGHT = 48;

export const ports = (id: string, type: NodeType) =>
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

export const Extras = ({ extras }: { extras: readonly ShapeExtra[] }) =>
  extras.map(({ element, attributes }, index) =>
    createElement(element, { key: index, ...attributes }),
  );

export function NodeShape({
  id,
  type,
  selected,
  highlighted,
  handles = ports(id, type),
  children,
}: {
  id: string;
  type: OutlinedType;
  selected: boolean;
  highlighted: boolean | undefined;
  handles?: ReactNode;
  children: ReactNode;
}) {
  const clip = `fd-clip-${useId().replace(/[^\w-]/g, "")}`;
  const { box, outline: stroke } = nodeLook(type);
  const { path: outline, padL, fill, strokeWidth, ink, extras } = nodeOutline(type);
  return (
    <div
      className="fd-node"
      data-testid={`node-${id}`}
      data-highlighted={highlighted === true ? "true" : undefined}
      title={nodeTitle(type)}
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
        <g clipPath={`url(#${clip})`}>
          <Extras extras={extras} />
          {children}
        </g>
      </svg>
      <div style={{ position: "absolute", left: padL, top: 25, color: ink ?? "var(--fg)" }}>
        <NodeStatusBadge nodeId={id} />
      </div>
      <NodeIssueMarker nodeId={id} />
      {handles}
    </div>
  );
}

export const tagTextStyle = { font: "600 9.5px var(--f-mono)", letterSpacing: "0.04em" };

export function TagChip({ x, tag, fill }: { x: number; tag: string; fill: string }) {
  return (
    <rect x={x} y={8} width={tagWidth(tag)} height={15} rx={4} fill={fill} fillOpacity={0.15} />
  );
}

export function TagPill({ type }: { type: OutlinedType }) {
  const { tag, group } = nodeLook(type);
  const { padL, ink } = nodeOutline(type);
  const fill = ink ?? group;
  return (
    <>
      <TagChip x={padL} tag={tag} fill={fill} />
      <text x={padL + 5} y={19} fill={fill} style={tagTextStyle}>
        {tag}
      </text>
    </>
  );
}

export function Label({ type, text }: { type: OutlinedType; text: string | undefined }) {
  const { padL, ink } = nodeOutline(type);
  return (
    <text
      x={padL + tagWidth(nodeLook(type).tag) + 6}
      y={20}
      fill={ink ?? "var(--fg)"}
      style={{ font: ink === undefined ? "600 13px var(--f-body)" : "600 12px var(--f-mono)" }}
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
        rx={frameLook.rx}
        fill={color}
        fillOpacity={frameLook.fillOpacity}
        stroke={color}
        strokeOpacity={frameLook.strokeOpacity}
        strokeWidth={frameLook.strokeWidth}
        strokeDasharray={dashed ? frameLook.dash : undefined}
      />
    </svg>
  );
}
