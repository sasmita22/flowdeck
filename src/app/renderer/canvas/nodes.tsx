import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CSSProperties } from "react";

type CanvasNode = Node<{ label: string }>;

const selectedOutline = (selected: boolean): CSSProperties =>
  selected ? { outline: "2px solid #2f6fed", outlineOffset: 2 } : {};

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
    <div data-testid={`node-${id}`} style={{ ...promptStyle, ...selectedOutline(selected) }}>
      {data.label}
      <Ports id={id} />
    </div>
  );
}

function ScriptNode({ id, data, selected }: NodeProps<CanvasNode>) {
  return (
    <div data-testid={`node-${id}`} style={{ ...scriptStyle, ...selectedOutline(selected) }}>
      {data.label}
      <Ports id={id} />
    </div>
  );
}

export const nodeTypes: NodeTypes = { prompt: PromptNode, script: ScriptNode };
