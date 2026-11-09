import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type ReactFlowProps,
  type ReactFlowState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, type DragEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { nodeTypes } from "../nodes/node-types.js";
import { PanelToggle } from "../panel-toggle.js";
import type { RunView } from "../run-store.js";
import { emptyCanvasHint, selectInspectorOpen, type ShellState } from "../shell-store.js";
import { controlTestIds, readoutTestIds } from "../test-ids.js";
import { AlignedEdge } from "./aligned-edge.js";
import { BranchEdge } from "./branch-edge.js";
import { FileEdge } from "./file-edge.js";
import { FileNamePrompt } from "./file-name-prompt.js";
import { openingViewport, startViewport } from "./fit.js";
import { NodeMenu } from "./node-menu.js";
import { nodeMimeType, Palette } from "./palette.js";
import { RenameField } from "./rename-field.js";
import { SessionChip } from "./session-chip.js";
import { claimsShortcut, shortcutFor } from "./shortcuts.js";
import { CanvasEditingContext, CanvasStoreContext } from "./status.js";
import { isCanvasItemType, selectCanDelete, selectCanvasEmpty, type CanvasState } from "./store.js";
import { toViewEdges, toViewNodes, type ViewEdge, type ViewNode } from "./view.js";

const deleteKeys = ["Delete", "Backspace"];
const proOptions = { hideAttribution: true };
const edgeTypes = { aligned: AlignedEdge, file: FileEdge, branch: BranchEdge };

const containerOfFrame = (node: ViewNode): string | undefined =>
  node.type === "loop-frame"
    ? node.data.loopId
    : node.type === "foreach-frame"
      ? node.data.forEachId
      : undefined;
const viewing = {
  deleteKeyCode: null,
  nodesDraggable: false,
  nodesConnectable: false,
  elementsSelectable: false,
  fitView: true,
  fitViewOptions: { maxZoom: 1 },
} satisfies Partial<ReactFlowProps>;

function Toolbar({ store, shell }: { store: StoreApi<CanvasState>; shell: StoreApi<ShellState> }) {
  const canUndo = useStore(store, (state) => state.undoStack.length > 0);
  const canRedo = useStore(store, (state) => state.redoStack.length > 0);
  const canDelete = useStore(store, selectCanDelete);
  const { undo, redo, deleteSelection } = store.getState();
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
      <SessionChip canvas={store} shell={shell} />
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
  readOnly,
}: {
  shell: StoreApi<ShellState>;
  run: StoreApi<RunView>;
  toolbar: ReactNode;
  readOnly: boolean;
}) {
  const sidebarOpen = useStore(shell, (state) => state.sidebarOpen);
  const inspectorShown = useStore(shell, (state) => state.inspectorShown);
  const snapshot = useStore(run, (state) => state.snapshot);
  const inspectorOpen = selectInspectorOpen({ inspectorShown }, { snapshot });
  return (
    <>
      <div className="fd-canvas-top fd-canvas-top-left">
        {!sidebarOpen && !readOnly && (
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

function CanvasMessage({ store }: { store: StoreApi<CanvasState> }) {
  const message = useStore(store, (state) => state.message);
  if (message === null) return null;
  return (
    <div className="fd-canvas-toast" data-testid="canvas-message" role="status">
      {message}
    </div>
  );
}

const allMeasured = ({ nodeLookup }: ReactFlowState) =>
  nodeLookup.size > 0 &&
  [...nodeLookup.values()].every(({ measured }) => (measured.width ?? 0) > 0);

function useFitOnOpen(store: StoreApi<CanvasState>) {
  const opened = useStore(store, (state) => state.opened);
  const initialized = useFlowStore(allMeasured);
  const width = useFlowStore((state) => state.width);
  const height = useFlowStore((state) => state.height);
  const { getNodes, getNodesBounds, setViewport } = useReactFlow();
  const fitted = useRef<number | null>(null);
  useEffect(() => {
    if (fitted.current === opened || width === 0 || height === 0) return;
    const nodes = getNodes();
    if (nodes.length > 0 && !initialized) return;
    fitted.current = opened;
    if (nodes.length === 0) return;
    void setViewport(openingViewport(getNodesBounds(nodes), { width, height }));
  }, [opened, initialized, width, height, getNodes, getNodesBounds, setViewport]);
}

function useFocus(store: StoreApi<CanvasState>) {
  const focus = useStore(store, (state) => state.focus);
  const { getInternalNode, getZoom, setCenter } = useReactFlow();
  useEffect(() => {
    if (focus === null) return;
    const node = getInternalNode(focus.node);
    if (node === undefined) return;
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured.width ?? 0;
    const height = node.measured.height ?? 0;
    void setCenter(x + width / 2, y + height / 2, { zoom: getZoom(), duration: 200 });
  }, [focus, getInternalNode, getZoom, setCenter]);
}

function useCanvasKeys(store: StoreApi<CanvasState>, onSave: (() => void) | undefined) {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event);
      if (shortcut === null) return;
      const state = store.getState();
      if (shortcut === "rename" && (state.selection.length !== 1 || state.renaming !== null)) {
        return;
      }
      if (!claimsShortcut(shortcut, state)) return;
      event.preventDefault();
      if (shortcut === "save") onSave?.();
      else if (shortcut === "zoomIn") void zoomIn();
      else if (shortcut === "zoomOut") void zoomOut();
      else if (shortcut === "zoomReset") void zoomTo(1);
      else if (shortcut === "rename") state.startRename();
      else state[shortcut]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, onSave, zoomIn, zoomOut, zoomTo]);
}

const renameOnDoubleClick = (store: StoreApi<CanvasState>) => (event: MouseEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  const id = target?.closest(".react-flow__node")?.getAttribute("data-id");
  if (id === null || id === undefined) return;
  if (!store.getState().flow.nodes.some((node) => node.id === id)) return;
  // d3-zoom zooms on a dblclick at the pane before React's root listener would see it.
  event.stopPropagation();
  store.getState().startRename(id);
};

function Board({
  store,
  shell,
  run,
  readOnly,
  onSave,
}: {
  store: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
  run: StoreApi<RunView>;
  readOnly: boolean;
  onSave: (() => void) | undefined;
}) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  const selectedWires = useStore(store, (state) => state.selectedWires);
  const dragPositions = useStore(store, (state) => state.dragPositions);
  const highlighted = useStore(store, (state) => state.highlighted);
  const noteBoxes = useStore(store, (state) => state.noteBoxes);
  const nodes = useMemo(
    () => toViewNodes(flow, selection, dragPositions, highlighted, noteBoxes),
    [flow, selection, dragPositions, highlighted, noteBoxes],
  );
  const edges = useMemo(() => toViewEdges(flow, selectedWires), [flow, selectedWires]);
  const { screenToFlowPosition } = useReactFlow();
  const board = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = board.current;
    if (readOnly || element === null) return;
    const onDoubleClick = renameOnDoubleClick(store);
    element.addEventListener("dblclick", onDoubleClick, true);
    return () => element.removeEventListener("dblclick", onDoubleClick, true);
  }, [store, readOnly]);

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

  const onEdgesChange = (changes: EdgeChange[]) => {
    const { selectedWires: current, selectWires } = store.getState();
    const selected = new Set(current);
    let selectionChanged = false;
    for (const change of changes) {
      if (change.type !== "select") continue;
      selectionChanged = true;
      if (change.selected) selected.add(change.id);
      else selected.delete(change.id);
    }
    if (selectionChanged) selectWires([...selected]);
  };

  const onConnect = ({ source, sourceHandle, target, targetHandle }: Connection) => {
    if (sourceHandle === null || targetHandle === null) return;
    store
      .getState()
      .connect({ node: source, port: sourceHandle }, { node: target, port: targetHandle });
  };

  const onConnectEnd = (_event: MouseEvent | TouchEvent, connection: FinalConnectionState) => {
    if (connection.isValid === false) store.getState().refuseConnection();
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

  const editing: Partial<ReactFlowProps<ViewNode, ViewEdge>> = {
    deleteKeyCode: deleteKeys,
    onNodesChange,
    onEdgesChange,
    onNodeDragStop: (_, __, dragged) => store.getState().endDrag(dragged.map((n) => n.id)),
    onBeforeDelete: async () => {
      store.getState().deleteSelection();
      return false;
    },
    onNodeContextMenu: (event, node) => {
      event.preventDefault();
      store.getState().openNodeMenu(node.id, { x: event.clientX, y: event.clientY });
    },
    onPaneClick: () => {
      store.getState().closeNodeMenu();
      shell.getState().closeSessionSettings();
    },
    onConnect,
    onConnectEnd,
    onDragOver,
    onDrop,
  };

  return (
    <div className="fd-canvas" data-testid="canvas" ref={board}>
      <CanvasStoreContext.Provider value={store}>
        <CanvasEditingContext.Provider value={!readOnly}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode="system"
            defaultMarkerColor={null}
            defaultViewport={startViewport}
            proOptions={proOptions}
            onNodeClick={(_, node) => {
              const container = containerOfFrame(node);
              if (container !== undefined) {
                if (readOnly) return;
                store.getState().select([container]);
              }
              if (node.type !== "note") shell.getState().showInspector();
            }}
            {...(readOnly ? viewing : editing)}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={2} color="var(--dot)" />
            <ZoomControls />
            {!readOnly && <FileNamePrompt store={store} />}
            {!readOnly && <RenameField store={store} />}
            {!readOnly && <EditorEffects store={store} onSave={onSave} />}
          </ReactFlow>
        </CanvasEditingContext.Provider>
      </CanvasStoreContext.Provider>
      <PanelShowButtons
        shell={shell}
        run={run}
        toolbar={readOnly ? null : <Toolbar store={store} shell={shell} />}
        readOnly={readOnly}
      />
      {!readOnly && <EmptyHint store={store} shell={shell} />}
      {!readOnly && <NodeMenu store={store} />}
      {!readOnly && <CanvasMessage store={store} />}
      <Readout store={store} />
    </div>
  );
}

function EditorEffects({
  store,
  onSave,
}: {
  store: StoreApi<CanvasState>;
  onSave: (() => void) | undefined;
}) {
  useFitOnOpen(store);
  useFocus(store);
  useCanvasKeys(store, onSave);
  return null;
}

function Readout({ store }: { store: StoreApi<CanvasState> }) {
  const flow = useStore(store, (state) => state.flow);
  const selection = useStore(store, (state) => state.selection);
  const selectedWires = useStore(store, (state) => state.selectedWires);
  return (
    <>
      <pre className="fd-visually-hidden" data-testid={readoutTestIds.flow}>
        {JSON.stringify(flow)}
      </pre>
      <pre className="fd-visually-hidden" data-testid={readoutTestIds.selection}>
        {JSON.stringify(selection)}
      </pre>
      <pre className="fd-visually-hidden" data-testid={readoutTestIds.wires}>
        {JSON.stringify(selectedWires)}
      </pre>
    </>
  );
}

export function Canvas({
  store,
  shell,
  run,
  onSave,
  readOnly = false,
  below,
}: {
  store: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
  run: StoreApi<RunView>;
  onSave?: () => void;
  readOnly?: boolean;
  below?: ReactNode;
}) {
  const board = <Board store={store} shell={shell} run={run} readOnly={readOnly} onSave={onSave} />;
  return (
    <ReactFlowProvider>
      {!readOnly && <Palette canvas={store} shell={shell} run={run} />}
      {below === undefined ? (
        board
      ) : (
        <div className="fd-canvas-column">
          {board}
          {below}
        </div>
      )}
    </ReactFlowProvider>
  );
}
