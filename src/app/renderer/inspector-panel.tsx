import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BranchState } from "./branch-store.js";
import type { CanvasState } from "./canvas/store.js";
import { Inspector, type RunPageView } from "./inspector/inspector.js";
import type { InspectorState } from "./inspector/store.js";
import type { WaitState } from "./inspector/wait-store.js";
import { PanelToggle } from "./panel-toggle.js";
import { ResizeHandle } from "./resize-handle.js";
import type { RunView } from "./run-store.js";
import { selectInspectorOpen, type ShellState } from "./shell-store.js";
import { controlTestIds } from "./test-ids.js";

export function InspectorPanel({
  shell,
  run,
  canvas,
  inspector,
  wait,
  readOnly = false,
  page,
  branches,
}: {
  shell: StoreApi<ShellState>;
  run: StoreApi<RunView>;
  canvas: StoreApi<CanvasState>;
  inspector: StoreApi<InspectorState>;
  wait?: StoreApi<WaitState> | undefined;
  readOnly?: boolean;
  page?: RunPageView | undefined;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const inspectorShown = useStore(shell, (state) => state.inspectorShown);
  const snapshot = useStore(run, (state) => state.snapshot);
  if (!selectInspectorOpen({ inspectorShown }, { snapshot })) return null;
  return (
    <>
      <ResizeHandle
        panel="inspector"
        label="Drag to resize the inspector"
        testId={controlTestIds.inspectorResize}
        shell={shell}
        run={run}
      />
      <div className="fd-inspector">
        <div className="fd-panel-head">
          <PanelToggle
            side="right"
            label="Hide inspector"
            testId={controlTestIds.inspectorHide}
            shell={shell}
            onClick={() => shell.getState().toggleInspector(run.getState())}
          />
          <h2 className="fd-panel-title">Inspector</h2>
        </div>
        <Inspector
          inspector={inspector}
          run={run}
          canvas={canvas}
          wait={wait}
          shell={shell}
          readOnly={readOnly}
          page={page}
          branches={branches}
        />
      </div>
    </>
  );
}
