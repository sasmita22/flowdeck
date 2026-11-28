import { useContext } from "react";
import { useStore } from "zustand";
import { CanvasStoreContext, emptyCanvasStore } from "../canvas/status.js";
import { selectNodeWarnings } from "../canvas/store.js";

export function WarningMarker({ x, text }: { x: number; text: string }) {
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

export function useFirstWarning(id: string): string | undefined {
  const store = useContext(CanvasStoreContext);
  const [warning] = useStore(store ?? emptyCanvasStore, (state) =>
    selectNodeWarnings(state.flow, id),
  );
  return warning;
}
