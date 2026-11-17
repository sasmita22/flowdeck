import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { RunState } from "./run-store.js";

export type ItemMenuEntry = {
  testId: string;
  label: string;
  onSelect(): void;
  disabled?: boolean;
  title?: string;
};

export function ItemMenu({
  run,
  menuKey,
  triggerTestId,
  label,
  items,
}: {
  run: StoreApi<RunState>;
  menuKey: string;
  triggerTestId: string;
  label: string;
  items: readonly ItemMenuEntry[];
}) {
  const open = useStore(run, (state) => state.menuOpen === menuKey);
  const [place, setPlace] = useState({ top: 0, right: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const { closeMenu } = run.getState();
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (menu.current?.contains(target) === true || trigger.current?.contains(target) === true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) closeMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [run, open]);

  const toggle = () => {
    const { openMenu, closeMenu } = run.getState();
    if (open) {
      closeMenu();
      return;
    }
    const box = trigger.current?.getBoundingClientRect();
    if (box !== undefined) setPlace({ top: box.bottom + 4, right: window.innerWidth - box.right });
    openMenu(menuKey);
  };

  return (
    <>
      <button
        ref={trigger}
        className="fd-btn fd-item-menu-trigger"
        data-testid={triggerTestId}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menu}
          className="fd-menu fd-menu-floating"
          role="menu"
          aria-label={label}
          style={place}
        >
          {items.map((item) => (
            <button
              key={item.testId}
              className="fd-menu-item"
              role="menuitem"
              data-testid={item.testId}
              disabled={item.disabled}
              aria-disabled={item.disabled}
              title={item.title}
              onClick={() => {
                if (item.disabled === true) return;
                run.getState().closeMenu();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
