import { useEffect, useRef, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { menuItems, nextMenuIndex, type MenuAction, type ShellState } from "./shell-store.js";
import type { TerminalState } from "./terminal/store.js";
import { controlTestIds } from "./test-ids.js";

export function MoreMenu({
  shell,
  terminal,
}: {
  shell: StoreApi<ShellState>;
  terminal: StoreApi<TerminalState>;
}) {
  const open = useStore(shell, (state) => state.menuOpen);
  const terminalOpen = useStore(terminal, (state) => state.visible);
  const terminalAvailable = useStore(terminal, (state) => state.available);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items = menuItems({ terminalOpen, terminalAvailable });

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) shell.getState().closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, shell]);

  const close = () => {
    shell.getState().closeMenu();
    trigger.current?.focus();
  };

  const perform = (action: MenuAction) => {
    if (action === "terminal-open") terminal.getState().show();
    else terminal.getState().close();
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const current = itemRefs.current.findIndex((item) => item === document.activeElement);
    const next = nextMenuIndex(current, event.key, items.length);
    if (next === current) return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  return (
    <div className="fd-menu-anchor" ref={anchor}>
      <button
        ref={trigger}
        className="fd-btn"
        data-testid={controlTestIds.more}
        aria-label="More actions"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : shell.getState().openMenu())}
      >
        ⋯
      </button>
      {open && (
        <div className="fd-menu" role="menu" aria-label="More actions" onKeyDown={onKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.testId}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              className="fd-menu-item"
              role="menuitem"
              data-testid={item.testId}
              aria-disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) perform(item.action);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
