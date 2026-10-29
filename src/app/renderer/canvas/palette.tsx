import type { CSSProperties, DragEvent } from "react";
import * as promptDefaults from "../../../core/nodes/prompt/defaults.js";
import * as scriptDefaults from "../../../core/nodes/script/defaults.js";
import type { CanvasNodeType } from "./store.js";

export const nodeMimeType = "application/flowdeck-node";

const items: { type: CanvasNodeType; label: string; style: CSSProperties }[] = [
  {
    type: "prompt",
    label: promptDefaults.defaultLabel,
    style: {
      background: "#ffffff",
      color: "#1d1d1f",
      border: "1.4px solid #3a3a3c",
      borderRadius: 4,
    },
  },
  {
    type: "script",
    label: scriptDefaults.defaultLabel,
    style: {
      background: "#1e1e1e",
      color: "#e6e6e6",
      border: "1px solid #1e1e1e",
      borderRadius: 6,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
];

const onDragStart = (type: CanvasNodeType) => (event: DragEvent<HTMLDivElement>) => {
  event.dataTransfer.setData(nodeMimeType, type);
  event.dataTransfer.effectAllowed = "move";
};

export function Palette() {
  return (
    <aside style={{ display: "flex", flexDirection: "column", gap: 8, width: 120 }}>
      {items.map(({ type, label, style }) => (
        <div
          key={type}
          data-testid={`palette-${type}`}
          draggable
          onDragStart={onDragStart(type)}
          style={{
            padding: "8px 12px",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            cursor: "grab",
            ...style,
          }}
        >
          {label}
        </div>
      ))}
    </aside>
  );
}
