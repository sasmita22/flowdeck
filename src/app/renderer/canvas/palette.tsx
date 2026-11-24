import { Fragment, useState, type DragEvent, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { ContainerPreview, NodePreview } from "../nodes/preview.js";
import { PanelToggle } from "../panel-toggle.js";
import { ResizeHandle, useShownWidth } from "../resize-handle.js";
import type { RunView } from "../run-store.js";
import type { ShellState } from "../shell-store.js";
import { controlTestIds } from "../test-ids.js";
import {
  filterLibraries,
  filterPalette,
  groupPalette,
  libraryItems,
  paletteItems,
  type LibraryItem,
  type PaletteItem,
} from "./palette-items.js";
import type { CanvasItemType, CanvasState } from "./store.js";

export const nodeMimeType = "application/flowdeck-node";

export const libraryMimeType = "application/flowdeck-library";

const onDragStart = (type: CanvasItemType) => (event: DragEvent<HTMLDivElement>) => {
  event.dataTransfer.setData(nodeMimeType, type);
  event.dataTransfer.effectAllowed = "move";
};

function Entry({ item, onAdd }: { item: PaletteItem; onAdd: (type: CanvasItemType) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onAdd(item.type);
  };
  return (
    <div
      className="fd-palette-item"
      data-testid={item.testId}
      tabIndex={0}
      draggable
      onDragStart={onDragStart(item.type)}
      onDoubleClick={() => onAdd(item.type)}
      onKeyDown={onKeyDown}
    >
      <span className="fd-palette-preview">
        {item.type === "workspace" || item.type === "session" ? (
          <ContainerPreview kind={item.type} />
        ) : (
          <NodePreview type={item.type} />
        )}
      </span>
      <span className="fd-palette-text">
        <span className="fd-palette-head">
          {item.tag !== "" && (
            <span
              className="fd-tag"
              style={{
                color: item.color,
                background: `color-mix(in srgb, ${item.color} 15%, transparent)`,
              }}
            >
              {item.tag}
            </span>
          )}
          {item.label}
        </span>
        <span className="fd-palette-description">{item.description}</span>
      </span>
    </div>
  );
}

function LibraryEntry({ item, onAdd }: { item: LibraryItem; onAdd: (flowId: string) => void }) {
  const loops = item.loop !== null;
  const add = () => {
    if (!loops) onAdd(item.flowId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };
  const onLibraryDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (loops) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(libraryMimeType, item.flowId);
    event.dataTransfer.effectAllowed = "move";
  };
  return (
    <div
      className="fd-palette-item"
      data-testid={item.testId}
      tabIndex={0}
      draggable={!loops}
      aria-disabled={loops}
      title={item.loop ?? undefined}
      onDragStart={onLibraryDragStart}
      onDoubleClick={add}
      onKeyDown={onKeyDown}
    >
      <span className="fd-palette-preview">
        <NodePreview type="library" />
      </span>
      <span className="fd-palette-text">
        <span className="fd-palette-head">{item.label}</span>
        <span className="fd-palette-description">{item.kindLabel}</span>
      </span>
    </div>
  );
}

export function Palette({
  canvas,
  shell,
  run,
}: {
  canvas: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
  run: StoreApi<RunView>;
}) {
  const open = useStore(shell, (state) => state.sidebarOpen);
  const width = useShownWidth(shell, run, "sidebar");
  const summaries = useStore(canvas, (state) => state.librarySummaries);
  const openFlowId = useStore(canvas, (state) => state.openFlowId);
  const [query, setQuery] = useState("");
  if (!open) return null;
  const groups = groupPalette(filterPalette(paletteItems, query));
  const libraries = filterLibraries(libraryItems(summaries, openFlowId), query);
  const onAdd = (type: CanvasItemType) => canvas.getState().addNext(type);
  const onAddLibrary = (flowId: string) => canvas.getState().addLibrary(flowId);
  return (
    <>
      <aside className="fd-sidebar" aria-label="Nodes" style={{ width }}>
        <div className="fd-panel-head">
          <h2 className="fd-panel-title">Nodes</h2>
          <PanelToggle
            side="left"
            label="Hide node sidebar"
            testId={controlTestIds.sidebarHide}
            shell={shell}
            onClick={() => shell.getState().toggleSidebar()}
          />
        </div>
        <input
          className="fd-search"
          data-testid={controlTestIds.search}
          type="search"
          placeholder="Search nodes"
          aria-label="Search nodes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {groups.length === 0 && libraries.length === 0 && (
          <p className="fd-palette-empty">No node matches “{query}”.</p>
        )}
        {groups.map(({ group, items }) => (
          <Fragment key={group}>
            {group !== "" && <h2 className="fd-group-heading">{group}</h2>}
            {items.map((item) => (
              <Entry key={item.type} item={item} onAdd={onAdd} />
            ))}
          </Fragment>
        ))}
        {libraries.length > 0 && <h2 className="fd-group-heading">Libraries</h2>}
        {libraries.map((item) => (
          <LibraryEntry key={item.flowId} item={item} onAdd={onAddLibrary} />
        ))}
      </aside>
      <ResizeHandle
        panel="sidebar"
        label="Drag to resize the node sidebar"
        testId={controlTestIds.sidebarResize}
        shell={shell}
        run={run}
      />
    </>
  );
}
