import { ViewportPortal } from "@xyflow/react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { nodeLook } from "../nodes/look.js";
import { widthOf } from "./frames.js";
import type { CanvasState, Naming } from "./store.js";

const below = 28;

const anchorOf = (state: CanvasState, naming: Naming) => {
  const corner = (id: string, side: "left" | "right") => {
    const node = state.flow.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) return { x: 0, y: 0 };
    return {
      x: node.position.x + (side === "left" ? 0 : widthOf(node)),
      y: node.position.y + nodeLook(node.type).box.height,
    };
  };
  const from = corner(naming.from.node, "right");
  const to = corner(naming.to.node, "left");
  return { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + below };
};

function NameField({ store, naming }: { store: StoreApi<CanvasState>; naming: Naming }) {
  const [file, setFile] = useState("");
  const { x, y } = anchorOf(store.getState(), naming);
  const { nameFile, cancelNaming } = store.getState();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    nameFile(file);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancelNaming();
  };
  return (
    <ViewportPortal>
      <form
        className="fd-file-name nodrag nopan nowheel"
        data-testid="file-name-form"
        style={{ transform: `translate(-50%, 0) translate(${x}px, ${y}px)` }}
        onSubmit={onSubmit}
      >
        <label className="fd-file-name-label" htmlFor="fd-file-name-input">
          File this wire carries
        </label>
        <input
          id="fd-file-name-input"
          className="fd-input"
          data-testid="file-name-input"
          placeholder="plan.md"
          autoFocus
          value={file}
          onChange={(event) => setFile(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="fd-btn" type="submit" data-testid="file-name-add">
          Add
        </button>
        <button
          className="fd-btn"
          type="button"
          data-testid="file-name-cancel"
          onClick={cancelNaming}
        >
          Cancel
        </button>
      </form>
    </ViewportPortal>
  );
}

export function FileNamePrompt({ store }: { store: StoreApi<CanvasState> }) {
  const naming = useStore(store, (state) => state.naming);
  if (naming === null) return null;
  const key = `${naming.from.node}:${naming.from.port}->${naming.to.node}:${naming.to.port}`;
  return <NameField key={key} store={store} naming={naming} />;
}
