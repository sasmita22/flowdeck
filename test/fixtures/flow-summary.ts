import type { FlowSummary } from "../../src/core/flow/flow-store.js";

export const flowSummary = (
  flowId: string,
  kind: FlowSummary["kind"],
  uses: string[],
): FlowSummary => ({
  flowId,
  name: flowId,
  createdAt: "2026-01-01T00:00:00.000Z",
  versions: 1,
  lastSavedAt: null,
  buildConfig: null,
  variables: [],
  pinned: false,
  kind,
  sessions: [],
  uses,
});
