import type { StoreApi } from "zustand/vanilla";
import type { FlowSummary } from "../../core/flow/flow-store.js";
import { Icon } from "./icons.js";
import type { LibraryState } from "./library-store.js";

export function PinButton({
  flow,
  library,
  testId,
}: {
  flow: Pick<FlowSummary, "flowId" | "name" | "pinned">;
  library: StoreApi<LibraryState>;
  testId: string;
}) {
  const verb = flow.pinned ? "Unpin" : "Pin";
  return (
    <button
      className="fd-btn fd-icon-btn fd-quiet"
      data-testid={testId}
      title={verb}
      aria-label={`${verb} ${flow.name}`}
      aria-pressed={flow.pinned}
      onClick={() => void library.getState().pin(flow.flowId, !flow.pinned)}
    >
      <Icon name="pin" />
    </button>
  );
}
