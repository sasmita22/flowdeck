import {
  layDown,
  lockBuild,
  workspaceDir,
  type BuildDeps,
  type BuildResult,
} from "../../src/core/compiler/build.js";
import { buildRecord } from "../../src/core/compiler/record.js";
import type { Flow } from "../../src/core/flow/schema.js";

export async function build(flow: Flow, deps: BuildDeps): Promise<BuildResult> {
  const laidDown = await layDown(flow, deps);
  if (!laidDown.ok) return laidDown;
  const dir = workspaceDir(deps.home, deps.workspace.id);
  const { hash, manifest } = await lockBuild(deps.fs, dir, laidDown.files);
  return { ok: true, hash, dir, record: buildRecord(dir, manifest, deps.workspace) };
}
