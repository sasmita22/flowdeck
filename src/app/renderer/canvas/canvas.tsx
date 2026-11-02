import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, type DragEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { nodeTypes } from "../nodes/node-types.js";
import { PanelToggle } from "../panel-toggle.js";
import type { RunState } from "../run-store.js";
import { emptyCanvasHint, selectInspectorOpen, type ShellState } from "../shell-store.js";
import { controlTestIds, readoutTestIds } from "../test-ids.js";
import { AlignedEdge } from "./aligned-edge.js";
import { NodeMenu } from "./node-menu.js";
import { nodeMimeType, Palette } from "./palette.js";
import { shortcutFor } from "./shortcuts.js";
import { CanvasStoreContext } from "./status.js";
import { isCanvasItemType, selectCanvasEmpty, wrappableIds, type CanvasState } from "./store.js";
import { toViewEdges, toViewNodes } from "./view.js";

const deleteKeys = ["Delete", "Backspace"];
const startViewport = { x: 24, y: 56, zoom: 1 };
const proOptions = { hideAttribution: true };
const edgeTypes = { aligned: AlignedEdge };

function Toolbar({ store }: { store: StoreApi<CanvasState> }) {
  const canUndo = useStore(store, (state) => state.undoStack.length > 0);
  const canRedo = useStore(store, (state) => state.redoStack.length > 0);
  const canDelete = useStore(store, (state) => state.selection.length > 0);
  const canWrap = useStore(store, (state) => wrappableIds(state.flow, state.selection).length > 0);
  const { undo, redo, deleteSelection, wrapSelection } = store.getState();
  return (
    <div className="fd-canvas-tools" role="toolbar" aria-label="Canvas">
      <button
        className="fd-btn"
        data-testid={controlTestIds.undo}
        disabled={!canUndo}
        onClick={undo}
      >
        Undo
      </button>
      <button
        className="fd-btn"
        data-testid={controlTestIds.redo}
        disabled={!canRedo}
        onClick={redo}
      >
        Redo
      </button>
      <button
        className="fd-btn"
        data-testid={controlTestIds.delete}
        disabled={!canDelete}
        onClick={deleteSelection}
      >
        Delete
      </button>
      <button
        className="fd-btn"
        data-testid={controlTestIds.wrap}
        disabled={!canWrap}
        onClick={wrapSelection}
      >
        Wrap in session
      </button>
    </div>
  );
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Controls
      position="bottom-left"
      orientation="horizontal"
      showZoom={false}
      showFitView={false}
      showInteractive={false}
    >
      <ControlButton data-testid={controlTestIds.zoomIn} onClick={() => void zoomIn()}>
        Zoom in
      </ControlButton>
      <ControlButton data-testid={controlTestIds.zoomOut} onClick={() => void zoomOut()}>
        Zoom out
      </ControlButton>
      <ControlButton data-testid={controlTestIds.fit} onClick={() => void fitView()}>
        Fit
      </ControlButton>
    </Controls>
  );
}

function PanelShowButtons({
  shell,
  run,
  toolbar,
}: {
  shell: StoreApi<ShellState>;
  run: StoreApi<RunState>;
  toolbar: ReactNode;
}) {
  const sidebarOpen = useStore(shell, (state) => state.sidebarOpen);
  const inspectorShown = useStore(shell, (state) => state.inspectorShown);
  const snapshot = useStore(run, (state) => state.snapshot);
  const inspectorOpen = selectInspectorOpen({ inspectorShown }, { snapshot });
  return (
    <>
      <div className="fd-canvas-top fd-canvas-top-left">
        {!sidebarOpen && (
          <PanelToggle
            side="left"
            label="Show node sidebar"
            testId={controlTestIds.sidebarShow}
            shell={shell}
            onClick={() => shell.getState().toggleSidebar()}
          />
        )}
        {toolbar}
      </div>
      {!inspectorOpen && (
        <div className="fd-canvas-top fd-canvas-top-right">
          <PanelToggle
            side="right"
            label="Show inspector"
            testId={controlTestIds.inspectorShow}
            shell={shell}
            onClick={() => shell.getState().toggleInspector(run.getState())}
          />
        </div>
      )}
    </>
  );
}

function EmptyHint({
  store,
  shell,
}: {
  store: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
}) {
  const empty = useStore(store, selectCanvasEmpty);
  const sidebarOpen = useStore(shell, (state) => state.sidebarOpen);
  const hint = emptyCanvasHint(empty, sidebarOpen);
  if (hint === null) return null;
  return (
    <div className="fd-empty-hint" data-testid="canvas-empty-hint">
      {hint}
    </div>
  );
}

function Board({
  store,
  shell,
  run,
}: {
  store: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
  run: StoreApi<RunState>;
}) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  const dragPositions = useStore(store, (state) => state.dragPositions);
  const highlighted = useStore(store, (state) => state.highlighted);
  const noteBoxes = useStore(store, (state) => state.noteBoxes);
  const nodes = useMemo(
    () => toViewNodes(flow, selection, dragPositions, highlighted, noteBoxes),
    [flow, selection, dragPositions, highlighted, noteBoxes],
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
    if (!isCanvasItemType(type)) return;
    const { x, y } = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    store.getState().drop(type, { x: Math.round(x), y: Math.round(y) });
  };

  return (
    <div className="fd-canvas" data-testid="canvas">
      <CanvasStoreContext.Provider value={store}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="system"
          defaultMarkerColor={null}
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
          onNodeClick={(_, node) => {
            if (node.type !== "note") shell.getState().showInspector();
          }}
          onPaneClick={() => {
            store.getState().closeNodeMenu();
            shell.getState().closeSessionSettings();
          }}
          onConnect={onConnect}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={2} color="var(--dot)" />
          <ZoomControls />
        </ReactFlow>
      </CanvasStoreContext.Provider>
      <PanelShowButtons shell={shell} run={run} toolbar={<Toolbar store={store} />} />
      <EmptyHint store={store} shell={shell} />
      <NodeMenu store={store} />
      <Readout store={store} />
    </div>
  );
}

function Readout({ store }: { store: StoreApi<CanvasState> }) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  return (
    <>
      <pre className="fd-visually-hidden" data-testid={readoutTestIds.flow}>
        {JSON.stringify(flow)}
      </pre>
      <pre className="fd-visually-hidden" data-testid={readoutTestIds.selection}>
        {JSON.stringify(selection)}
      </pre>
    </>
  );
}

export function Canvas({
  store,
  shell,
  run,
  onSave,
}: {
  store: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
  run: StoreApi<RunState>;
  onSave: () => void;
}) {
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
      <Palette canvas={store} shell={shell} />
      <Board store={store} shell={shell} run={run} />
    </ReactFlowProvider>
  );
}
