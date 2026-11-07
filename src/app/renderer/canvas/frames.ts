import type { Flow, Node, NodeType } from "../../../core/flow/schema.js";
import { defaultLabel as foreachLabel } from "../../../core/nodes/foreach/defaults.js";
import { defaultLabel as loopLabel } from "../../../core/nodes/loop/defaults.js";
import { nodeLook, tagWidth } from "../nodes/look.js";
import { nodeOutline, type OutlinedType } from "../nodes/outlines.js";
import { renderedWidth } from "./text-measure.js";

type Position = { x: number; y: number };

export type Bounds = { left: number; top: number; right: number; bottom: number };

export const FRAME_PADDING = 24;

const labelCharWidth = 7;

export const labelFonts = {
  body: "600 13px var(--f-body)",
  mono: "600 12px var(--f-mono)",
} as const;

export type LabelFont = keyof typeof labelFonts;

const charWidths: Record<LabelFont, number> = { body: 7, mono: 7.2 };

export const isContainer = (node: Pick<Node, "type">): boolean =>
  node.type === "loop" || node.type === "foreach";

export const containerSub = (node: Node): string | undefined => {
  if (node.type === "loop") return `max ${node.settings.cap}`;
  if (node.type === "foreach") return node.settings.file;
  return undefined;
};

const defaultLabels = { loop: loopLabel, foreach: foreachLabel };

export const containerText = (
  type: "loop" | "foreach",
  label: string,
  sub: string | undefined,
): string =>
  [
    nodeLook(type).tag,
    ...(label === defaultLabels[type] ? [] : [label]),
    ...(sub === undefined ? [] : [sub]),
  ].join(" · ");

export const containerLabelWidth = (type: "loop" | "foreach", text: string): number =>
  Math.max(nodeLook(type).box.width, text.length * labelCharWidth + 2 * nodeOutline(type).padL);

export const labelTextWidth = (text: string, font: LabelFont): number =>
  renderedWidth(text, labelFonts[font]) ?? text.length * charWidths[font];

export const labelX = (type: OutlinedType): number =>
  nodeOutline(type).padL + tagWidth(nodeLook(type).tag) + 6;

export const textWidth = (type: OutlinedType, text: string): number => {
  const { padL, ink } = nodeOutline(type);
  return labelX(type) + labelTextWidth(text, ink === undefined ? "body" : "mono") + padL;
};

export const nodeWidth = ({
  type,
  label,
  sub,
}: {
  type: NodeType;
  label: string;
  sub?: string | undefined;
}): number => {
  if (type === "loop" || type === "foreach")
    return containerLabelWidth(type, containerText(type, label, sub));
  if (type === "fork" || type === "join") return nodeLook(type).box.width;
  return Math.max(nodeLook(type).box.width, textWidth(type, label), textWidth(type, sub ?? ""));
};

export const nodeSub = (node: Node): string | undefined =>
  node.type === "branch" ? node.settings.variable : containerSub(node);

export const widthOf = (node: Node): number =>
  nodeWidth({ type: node.type, label: node.label, sub: nodeSub(node) });

export const boundsOf = (node: Node): Bounds => {
  const { x, y } = node.position;
  return { left: x, top: y, right: x + widthOf(node), bottom: y + nodeLook(node.type).box.height };
};

export const padded = (all: readonly Bounds[]): Bounds => ({
  left: Math.min(...all.map(({ left }) => left)) - FRAME_PADDING,
  top: Math.min(...all.map(({ top }) => top)) - FRAME_PADDING,
  right: Math.max(...all.map(({ right }) => right)) + FRAME_PADDING,
  bottom: Math.max(...all.map(({ bottom }) => bottom)) + FRAME_PADDING,
});

export const bodyFrameBounds = (flow: Flow, scope: Node): Bounds =>
  padded([scope, ...flow.nodes.filter((node) => node.parent === scope.id)].map(boundsOf));

const contains = ({ left, top, right, bottom }: Bounds, { x, y }: Position) =>
  x >= left && x <= right && y >= top && y <= bottom;

export const containerAt = (flow: Flow, point: Position): string | undefined =>
  flow.nodes.find(
    (node) =>
      isContainer(node) &&
      node.parent === undefined &&
      contains(bodyFrameBounds(flow, node), point),
  )?.id;

export const centerOf = (node: Node): Position => ({
  x: node.position.x + widthOf(node) / 2,
  y: node.position.y + nodeLook(node.type).box.height / 2,
});

export const bodyOf = (flow: Flow, containerId: string): Node[] =>
  flow.nodes.filter((node) => node.parent === containerId);

export const containerMoves = (
  flow: Flow,
  dragPositions: Readonly<Record<string, Position>>,
): Record<string, Position> => {
  const positions: Record<string, Position> = {};
  for (const container of flow.nodes.filter(isContainer)) {
    const to = dragPositions[container.id];
    if (to === undefined) continue;
    const dx = to.x - container.position.x;
    const dy = to.y - container.position.y;
    positions[container.id] = { ...to };
    for (const node of bodyOf(flow, container.id)) {
      positions[node.id] = { x: node.position.x + dx, y: node.position.y + dy };
    }
  }
  return positions;
};

export const followed = (
  flow: Flow,
  dragPositions: Readonly<Record<string, Position>>,
): Record<string, Position> => ({ ...containerMoves(flow, dragPositions), ...dragPositions });

export const withPositions = (flow: Flow, positions: Readonly<Record<string, Position>>): Flow => ({
  ...flow,
  nodes: flow.nodes.map((node) => {
    const position = positions[node.id];
    return position === undefined ? node : { ...node, position: { ...position } };
  }),
});
