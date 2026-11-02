import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ShellState } from "./shell-store.js";
import { controlTestIds } from "./test-ids.js";

const label = "Session settings";

const teeth = 8;
const gearOutline = Array.from({ length: teeth * 4 }, (_, index) => {
  const tooth = Math.floor(index / 4);
  const corner = index % 4;
  const radius = corner === 1 || corner === 2 ? 6.5 : 4.8;
  const offset = [-0.32, -0.16, 0.16, 0.32][corner] ?? 0;
  const angle = ((tooth + offset) / teeth) * 2 * Math.PI;
  const x = (8 + radius * Math.cos(angle)).toFixed(2);
  const y = (8 + radius * Math.sin(angle)).toFixed(2);
  return `${index === 0 ? "M" : "L"}${x} ${y}`;
}).join(" ");

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={`${gearOutline} Z`} fill="none" stroke="currentColor" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function SessionSettingsButton({ shell }: { shell: StoreApi<ShellState> }) {
  const open = useStore(shell, (state) => state.sessionSettingsOpen);
  return (
    <button
      className="fd-btn fd-icon-btn"
      data-testid={controlTestIds.sessionSettings}
      title={label}
      aria-label={label}
      aria-pressed={open}
      onClick={() => shell.getState().toggleSessionSettings()}
    >
      <GearIcon />
    </button>
  );
}
