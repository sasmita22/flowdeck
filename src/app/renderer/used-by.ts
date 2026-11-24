import type { FlowSummary } from "../../core/flow/flow-store.js";
import { usedBy } from "../../core/flow/libraries.js";
import type { Actions } from "./actions.js";
import type { LibraryState } from "./library-store.js";

export const isLibrary = (kind: FlowSummary["kind"]) =>
  kind === "node-library" || kind === "session-library";

export function libraryUsers(
  summaries: readonly FlowSummary[],
  flowId: string | undefined,
): FlowSummary[] | null {
  const library = summaries.find((summary) => summary.flowId === flowId);
  return library !== undefined && isLibrary(library.kind)
    ? usedBy(summaries, library.flowId)
    : null;
}

export const openUserFromDelete =
  (library: Pick<LibraryState, "cancelDelete">, actions: Pick<Actions, "openBlueprint">) =>
  (flowId: string): void => {
    library.cancelDelete();
    void actions.openBlueprint(flowId);
  };
