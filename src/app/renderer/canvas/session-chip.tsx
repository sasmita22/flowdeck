import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import type { ShellState } from "../shell-store.js";
import { controlTestIds } from "../test-ids.js";
import type { CanvasState } from "./store.js";

const modelName = (model: string) =>
  modelChoices.find(({ value }) => value === model)?.label ?? model;

export function SessionChip({
  canvas,
  shell,
}: {
  canvas: StoreApi<CanvasState>;
  shell: StoreApi<ShellState>;
}) {
  const name = useStore(canvas, (state) => state.flow.session.name);
  const model = useStore(canvas, (state) => state.flow.session.model);
  return (
    <button
      className="fd-session-chip"
      data-testid={controlTestIds.sessionChip}
      title="This canvas runs as one Claude Code session. Click to set it up."
      onClick={() => shell.getState().openSessionSettings()}
    >
      <span className="fd-session-chip-tag">SESSION</span>
      <span data-testid="session-chip-name">{name}</span>
      <span className="fd-session-chip-model">{modelName(model)}</span>
    </button>
  );
}
