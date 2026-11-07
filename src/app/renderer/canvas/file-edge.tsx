import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useContext, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { controlTestIds } from "../test-ids.js";
import { CanvasEditingContext, CanvasStoreContext } from "./status.js";
import type { CanvasState } from "./store.js";

function WireNameField({
  store,
  edgeId,
  file,
  style,
}: {
  store: StoreApi<CanvasState>;
  edgeId: string;
  file: string;
  style: CSSProperties;
}) {
  const finished = useRef(false);

  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    const { renameWire, cancelWireRename } = store.getState();
    if (name === null) cancelWireRename();
    else renameWire(name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") finish(event.currentTarget.value);
    if (event.key === "Escape") finish(null);
  };

  return (
    <input
      key={edgeId}
      ref={(input) => {
        if (input === null) return;
        finished.current = false;
        input.focus();
        input.select();
      }}
      className="fd-file-wire-label fd-file-wire-input nodrag nopan"
      data-testid={controlTestIds.fileWireName(edgeId)}
      aria-label={`Rename the file ${file}`}
      defaultValue={file}
      size={Math.max(file.length, 8)}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

function WireLabel({
  store,
  edgeId,
  file,
  testId,
  selected,
  style,
}: {
  store: StoreApi<CanvasState>;
  edgeId: string;
  file: string;
  testId: string;
  selected: boolean;
  style: CSSProperties;
}) {
  const renaming = useStore(store, (state) => state.renamingWire === edgeId);
  if (renaming) return <WireNameField store={store} edgeId={edgeId} file={file} style={style} />;
  return (
    <div
      className={`fd-file-wire-label${selected ? " fd-file-wire-renamable nodrag nopan" : ""}`}
      data-testid={testId}
      style={style}
      {...(selected && { onClick: () => store.getState().startWireRename(edgeId) })}
    >
      {file}
    </div>
  );
}

export function FileEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  markerEnd,
}: EdgeProps<Edge<{ file: string }>>) {
  const store = useContext(CanvasStoreContext);
  const editing = useContext(CanvasEditingContext);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const file = data?.file ?? "";
  const testId = `file-wire-${source}-${target}-${file}`;
  const style = { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` };
  return (
    <>
      <BaseEdge
        path={path}
        className="fd-file-wire"
        style={{ strokeDasharray: "6 4" }}
        {...(markerEnd !== undefined && { markerEnd })}
      />
      <EdgeLabelRenderer>
        {editing && store !== null ? (
          <WireLabel
            store={store}
            edgeId={id}
            file={file}
            testId={testId}
            selected={selected === true}
            style={style}
          />
        ) : (
          <div className="fd-file-wire-label" data-testid={testId} style={style}>
            {file}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
