import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CSSProperties } from "react";
import { NodeStatusBadge } from "./status.js";

type CanvasNode = Node<{ label: string; highlighted: boolean }>;

const selectedOutline = (selected: boolean): CSSProperties =>
  selected ? { outline: "2px solid #2f6fed", outlineOffset: 2 } : {};

const highlightRing = (highlighted: boolean): CSSProperties =>
  highlighted ? { boxShadow: "0 0 0 4px #f59e0b" } : {};

const promptStyle: CSSProperties = {
  padding: "8px 14px",
  minWidth: 120,
  background: "#ffffff",
  color: "#1d1d1f",
  border: "1.4px solid #3a3a3c",
  borderRadius: 4,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};

const scriptStyle: CSSProperties = {
  padding: "8px 14px",
  minWidth: 120,
  background: "#1e1e1e",
  color: "#e6e6e6",
  border: "1px solid #1e1e1e",
  borderRadius: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
};

function Ports({ id }: { id: string }) {
  return (
    <>
      <Handle type="target" id="in" position={Position.Left} data-testid={`port-${id}-in`} />
      <Handle type="source" id="out" position={Position.Right} data-testid={`port-${id}-out`} />
    </>
  );
}

function PromptNode({ id, data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      data-testid={`node-${id}`}
      data-highlighted={data.highlighted ? "true" : undefined}
      style={{ ...promptStyle, ...selectedOutline(selected), ...highlightRing(data.highlighted) }}
    >
      {data.label}
      <NodeStatusBadge nodeId={id} />
      <Ports id={id} />
    </div>
  );
}

function ScriptNode({ id, data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      data-testid={`node-${id}`}
      data-highlighted={data.highlighted ? "true" : undefined}
      style={{ ...scriptStyle, ...selectedOutline(selected), ...highlightRing(data.highlighted) }}
    >
      {data.label}
      <NodeStatusBadge nodeId={id} />
      <Ports id={id} />
    </div>
  );
}

export const nodeTypes: NodeTypes = { prompt: PromptNode, script: ScriptNode };
