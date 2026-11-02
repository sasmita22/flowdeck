import { Fragment, useState, type DragEvent, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { NodeType } from "../../../core/flow/schema.js";
import { PanelToggle } from "../panel-toggle.js";
import type { ShellState } from "../shell-store.js";
import { controlTestIds } from "../test-ids.js";
import { filterPalette, groupPalette, paletteItems, type PaletteItem } from "./palette-items.js";
import type { CanvasState } from "./store.js";

export const nodeMimeType = "application/flowdeck-node";

const onDragStart = (type: NodeType) => (event: DragEvent<HTMLDivElement>) => {
  event.dataTransfer.setData(nodeMimeType, type);
  event.dataTransfer.effectAllowed = "move";
};

function Entry({ item, onAdd }: { item: PaletteItem; onAdd: (type: NodeType) => void }) {
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
      <span className="fd-palette-head">
        <span
          className="fd-tag"
          style={{
            color: item.color,
            background: `color-mix(in srgb, ${item.color} 15%, transparent)`,
          }}
        >
          {item.tag}
        </span>
        {item.label}
      </span>
      <span className="fd-palette-description">{item.description}</span>
    </div>
  );
}

export function Palette({
  canvas,
  shell,
}: {
  canvas: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
}) {
  const open = useStore(shell, (state) => state.sidebarOpen);
  const [query, setQuery] = useState("");
  if (!open) return null;
  const groups = groupPalette(filterPalette(paletteItems, query));
  const onAdd = (type: NodeType) => canvas.getState().addNext(type);
  return (
    <aside className="fd-sidebar" aria-label="Nodes">
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
      {groups.length === 0 && <p className="fd-palette-empty">No node matches “{query}”.</p>}
      {groups.map(({ group, items }) => (
        <Fragment key={group}>
          <h2 className="fd-group-heading">{group}</h2>
          {items.map((item) => (
            <Entry key={item.type} item={item} onAdd={onAdd} />
          ))}
        </Fragment>
      ))}
    </aside>
  );
}
