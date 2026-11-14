import { flowSvg } from "../flow/flow-svg.js";
import type { FlowStore } from "../flow/flow-store.js";
import type { NewBuildSnapshot, SnapshotGap, Store } from "./store.js";

export type BackfillSnapshotsDeps = {
  store: Pick<Store, "listSnapshotGaps" | "addSnapshotIfMissing">;
  flows: Pick<FlowStore, "load">;
};

export type BackfillFailure = { gap: SnapshotGap; error: unknown };

export type BackfillResult = { added: number; failures: BackfillFailure[] };

const savedVersionOf = (gap: SnapshotGap) =>
  gap.flowId === null || gap.version === null || gap.flowId.startsWith("file:")
    ? null
    : { flowId: gap.flowId, version: gap.version };

const snapshotFor = (gap: SnapshotGap, flows: BackfillSnapshotsDeps["flows"]) => {
  const ref = savedVersionOf(gap);
  const saved = ref === null ? null : flows.load(ref);
  if (saved === null) return null;
  return {
    blueprintName: gap.blueprintName ?? saved.name,
    version: saved.version,
    flow: saved.flow,
    svg: flowSvg(saved.flow),
  };
};

export function backfillSnapshots({ store, flows }: BackfillSnapshotsDeps): BackfillResult {
  let added = 0;
  const failures: BackfillFailure[] = [];
  for (const gap of store.listSnapshotGaps()) {
    let snapshot: NewBuildSnapshot | null;
    try {
      snapshot = snapshotFor(gap, flows);
    } catch (error) {
      failures.push({ gap, error });
      continue;
    }
    if (snapshot !== null && store.addSnapshotIfMissing(gap, snapshot)) added += 1;
  }
  return { added, failures };
}
