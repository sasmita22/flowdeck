import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, type DragEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { nodeTypes } from "../nodes/node-types.js";
import { NodeMenu } from "./node-menu.js";
import { nodeMimeType, Palette } from "./palette.js";
import { shortcutFor } from "./shortcuts.js";
import { wrappableIds, type CanvasNodeType, type CanvasState } from "./store.js";
import { toViewEdges, toViewNodes } from "./view.js";

const deleteKeys = ["Delete", "Backspace"];
const startViewport = { x: 0, y: 0, zoom: 1 };
const proOptions = { hideAttribution: true };
const readoutStyle = { margin: 0, fontFamily: "ui-monospace, monospace", fontSize: 11 };

const isNodeType = (value: string): value is CanvasNodeType =>
  value === "prompt" || value === "script";

function Toolbar({ store }: { store: StoreApi<CanvasState> }) {
  const canUndo = useStore(store, (state) => state.undoStack.length > 0);
  const canRedo = useStore(store, (state) => state.redoStack.length > 0);
  const canDelete = useStore(store, (state) => state.selection.length > 0);
  const canWrap = useStore(store, (state) => wrappableIds(state.flow, state.selection).length > 0);
  const message = useStore(store, (state) => state.message);
  const { undo, redo, deleteSelection, wrapSelection } = store.getState();
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <button data-testid="canvas-undo" disabled={!canUndo} onClick={undo}>
        Undo
      </button>
      <button data-testid="canvas-redo" disabled={!canRedo} onClick={redo}>
        Redo
      </button>
      <button data-testid="canvas-delete" disabled={!canDelete} onClick={deleteSelection}>
        Delete
      </button>
      <button data-testid="canvas-wrap" disabled={!canWrap} onClick={wrapSelection}>
        Wrap in session
      </button>
      {message !== null && <span data-testid="canvas-message">{message}</span>}
    </div>
  );
}

function Board({ store }: { store: StoreApi<CanvasState> }) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  const dragPositions = useStore(store, (state) => state.dragPositions);
  const highlighted = useStore(store, (state) => state.highlighted);
  const nodes = useMemo(
    () => toViewNodes(flow, selection, dragPositions, highlighted),
    [flow, selection, dragPositions, highlighted],
  );
  const edges = useMemo(() => toViewEdges(flow), [flow]);
  const { screenToFlowPosition } = useReactFlow();

  const onNodesChange = (changes: NodeChange[]) => {
    const { selection: current, select, dragTo } = store.getState();
    const selected = new Set(current);
    let selectionChanged = false;
    for (const change of changes) {
      if (change.type === "select") {
        selectionChanged = true;
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      } else if (change.type === "position" && change.dragging && change.position) {
        dragTo(change.id, change.position);
      }
    }
    if (selectionChanged) select([...selected]);
  };

  const onConnect = ({ source, sourceHandle, target, targetHandle }: Connection) => {
    if (sourceHandle === null || targetHandle === null) return;
    store
      .getState()
      .connect({ node: source, port: sourceHandle }, { node: target, port: targetHandle });
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData(nodeMimeType);
    if (!isNodeType(type)) return;
    const { x, y } = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    store.getState().drop(type, { x: Math.round(x), y: Math.round(y) });
  };

  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Palette />
      <div data-testid="canvas" style={{ flex: 1, height: 600, outline: "1px solid #d0d0d0" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="system"
          defaultViewport={startViewport}
          deleteKeyCode={deleteKeys}
          proOptions={proOptions}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, __, dragged) => store.getState().endDrag(dragged.map((n) => n.id))}
          onBeforeDelete={async () => {
            store.getState().deleteSelection();
            return false;
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            store.getState().openNodeMenu(node.id, { x: event.clientX, y: event.clientY });
          }}
          onPaneClick={() => store.getState().closeNodeMenu()}
          onConnect={onConnect}
          onDragOver={onDragOver}
          onDrop={onDrop}
        />
        <NodeMenu store={store} />
      </div>
    </div>
  );
}

function Readout({ store }: { store: StoreApi<CanvasState> }) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  return (
    <section style={{ marginTop: 8 }}>
      <pre data-testid="canvas-flow" style={readoutStyle}>
        {JSON.stringify(flow)}
      </pre>
      <pre data-testid="canvas-selection" style={readoutStyle}>
        {JSON.stringify(selection)}
      </pre>
    </section>
  );
}

export function Canvas({ store, onSave }: { store: StoreApi<CanvasState>; onSave: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event);
      if (shortcut === null) return;
      event.preventDefault();
      const state = store.getState();
      if (shortcut === "save") onSave();
      else if (shortcut === "selectAll") state.select(state.flow.nodes.map((node) => node.id));
      else state[shortcut]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, onSave]);

  return (
    <ReactFlowProvider>
      <Toolbar store={store} />
      <Board store={store} />
      <Readout store={store} />
    </ReactFlowProvider>
  );
}
