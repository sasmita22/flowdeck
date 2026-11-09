import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { pageTestIds } from "../test-ids.js";
import type { AssistantState } from "./assistant-store.js";

export function StopAgentPrompt({ assistant }: { assistant: StoreApi<AssistantState> }) {
  const open = useStore(assistant, (state) => state.confirmingStop);
  if (!open) return null;
  const { end, cancelStop } = assistant.getState();
  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stop-agent-text"
        data-testid={pageTestIds.stopAgentDialog}
      >
        <p id="stop-agent-text">
          Stop the agent? Its conversation ends; edits it made stay on the canvas.
        </p>
        <div className="fd-dialog-actions">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.stopAgentConfirm}
            onClick={() => void end()}
          >
            Stop agent
          </button>
          <button className="fd-btn" data-testid={pageTestIds.stopAgentCancel} onClick={cancelStop}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
