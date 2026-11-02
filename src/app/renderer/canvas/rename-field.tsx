import { ViewportPortal } from "@xyflow/react";
import { useRef, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { nodeLook } from "../nodes/look.js";
import type { CanvasState } from "./store.js";

export function RenameField({ store }: { store: StoreApi<CanvasState> }) {
  const node = useStore(store, (state) =>
    state.renaming === null
      ? undefined
      : state.flow.nodes.find((candidate) => candidate.id === state.renaming),
  );
  const finished = useRef(false);
  if (node === undefined) return null;

  const finish = (label: string | null) => {
    if (finished.current) return;
    finished.current = true;
    const { rename, cancelRename } = store.getState();
    if (label === null) cancelRename();
    else rename(label);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish(event.currentTarget.value);
    if (event.key === "Escape") finish(null);
  };

  const { x, y } = node.position;
  return (
    <ViewportPortal>
      <input
        key={node.id}
        ref={(input) => {
          if (input === null) return;
          finished.current = false;
          input.focus();
          input.select();
        }}
        className="fd-rename nodrag nopan"
        data-testid="node-rename"
        aria-label={`Rename ${node.label}`}
        defaultValue={node.label}
        style={{
          transform: `translate(${x}px, ${y - 2}px)`,
          width: Math.max(nodeLook(node.type).box.width, 140),
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => finish(event.currentTarget.value)}
      />
    </ViewportPortal>
  );
}
