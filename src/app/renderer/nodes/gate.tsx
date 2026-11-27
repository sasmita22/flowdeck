import type { NodeProps } from "@xyflow/react";
import { useContext } from "react";
import { useStore } from "zustand";
import { nodeWidth } from "../canvas/frames.js";
import { CanvasStoreContext, emptyCanvasStore } from "../canvas/status.js";
import { selectNodeWarnings } from "../canvas/store.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

function WarningMarker({ x, text }: { x: number; text: string }) {
  return (
    <g data-testid="node-warning" role="img" aria-label={text}>
      <title>{text}</title>
      <circle cx={x} cy={0} r={7} fill="var(--warn)" />
      <text
        x={x}
        y={3.5}
        textAnchor="middle"
        fill="var(--panel)"
        style={{ font: "700 10px var(--f-body)" }}
      >
        !
      </text>
    </g>
  );
}

export function GateNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const store = useContext(CanvasStoreContext);
  const [warning] = useStore(store ?? emptyCanvasStore, (state) =>
    selectNodeWarnings(state.flow, id),
  );
  const width = nodeWidth({ type: "gate", label: data.label ?? "" });
  return (
    <NodeShape
      id={id}
      type="gate"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={width}
      overlay={warning === undefined ? undefined : <WarningMarker x={width} text={warning} />}
    >
      <TagPill type="gate" />
      <Label type="gate" text={data.label} />
    </NodeShape>
  );
}
