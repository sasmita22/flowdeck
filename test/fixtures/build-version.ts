import type { BuildResult } from "../../src/core/compiler/build.js";
import {
  runBuild,
  startBuild,
  type BuildFlowDeps,
  type BuildRequest,
} from "../../src/core/compiler/build-version.js";
import type { FlowStore, SavedFlowRef } from "../../src/core/flow/flow-store.js";

export type BuildVersionDeps = BuildFlowDeps & { flows: Pick<FlowStore, "load" | "loadLatest"> };

export async function buildVersion(
  ref: SavedFlowRef,
  request: BuildRequest,
  deps: BuildVersionDeps,
): Promise<BuildResult> {
  const saved = deps.flows.load(ref);
  if (saved === null) throw new Error(`${ref.flowId} has no saved version ${ref.version}`);
  const origin = {
    source: { flowId: ref.flowId, version: ref.version },
    blueprint: { name: saved.name, version: saved.version },
  };
  const started = await startBuild(saved.flow, request, deps, origin);
  if ("errors" in started) return started;
  return runBuild(started, started.flow, request, deps, origin);
}
