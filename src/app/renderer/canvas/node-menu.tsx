import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { CanvasState } from "./store.js";

export function NodeMenu({ store }: { store: StoreApi<CanvasState> }) {
  const menu = useStore(store, (state) => state.menu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menu === null) return;
    const { closeNodeMenu } = store.getState();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNodeMenu();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && ref.current?.contains(event.target))) closeNodeMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [store, menu]);

  if (menu === null) return null;
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="node-menu"
      style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        padding: 4,
        background: "Canvas",
        color: "CanvasText",
        border: "1px solid GrayText",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.2)",
      }}
    >
      <button
        role="menuitem"
        data-testid="node-menu-delete"
        onClick={() => store.getState().deleteNodes([menu.nodeId])}
      >
        Delete
      </button>
    </div>
  );
}
