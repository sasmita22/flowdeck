import type { FlowStore, SavedFlowRef } from "../flow/flow-store.js";
import type { Store } from "../run/store.js";
import { build, type BuildDeps, type BuildResult } from "./build.js";

export type BuildVersionDeps = Omit<BuildDeps, "source"> & {
  flows: Pick<FlowStore, "load">;
  store: Pick<Store, "recordBuild">;
};

export async function buildVersion(
  ref: SavedFlowRef,
  deps: BuildVersionDeps,
): Promise<BuildResult> {
  const saved = deps.flows.load(ref);
  if (saved === null) {
    return {
      ok: false,
      errors: [{ rule: "version", message: `${ref.flowId} has no saved version ${ref.version}` }],
    };
  }
  const result = await build(saved.flow, {
    ...deps,
    source: { flowId: ref.flowId, version: ref.version },
  });
  if (result.ok) deps.store.recordBuild(result.record);
  return result;
}
