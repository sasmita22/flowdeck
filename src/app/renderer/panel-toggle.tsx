import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { ShellState } from "./shell-store.js";

export type PanelSide = "left" | "right";

function PanelIcon({ side }: { side: PanelSide }) {
  const edge = side === "left" ? 6 : 10;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
      <line x1={edge} y1="2.5" x2={edge} y2="13.5" stroke="currentColor" />
    </svg>
  );
}

export function PanelToggle({
  side,
  label,
  testId,
  shell,
  onClick,
}: {
  side: PanelSide;
  label: string;
  testId: string;
  shell: StoreApi<ShellState>;
  onClick: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (shell.getState().panelFocus !== testId) return;
    button.current?.focus();
    shell.getState().clearPanelFocus();
  }, [shell, testId]);

  return (
    <button
      ref={button}
      className="fd-btn fd-icon-btn"
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <PanelIcon side={side} />
    </button>
  );
}
