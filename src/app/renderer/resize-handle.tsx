import { useRef, type PointerEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Panel, ShellState } from "./shell-store.js";

const growsRightward: Record<Panel, number> = { sidebar: 1, inspector: -1 };

export function ResizeHandle({
  panel,
  label,
  testId,
  shell,
}: {
  panel: Panel;
  label: string;
  testId: string;
  shell: StoreApi<ShellState>;
}) {
  const width = useStore(shell, (state) => state.panelWidths[panel]);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return;
    const moved = (event.clientX - drag.current.startX) * growsRightward[panel];
    shell.getState().resizePanel(panel, drag.current.startWidth + moved);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="fd-resize"
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => shell.getState().resetPanelWidth(panel)}
    />
  );
}
