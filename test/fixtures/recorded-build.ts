import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import type { BuildReport } from "../../src/core/compiler/build-report.js";
import { checkBuild, type BuildCheckFailure } from "../../src/core/compiler/check-build.js";
import { reportPath } from "../../src/core/compiler/emit.js";
import type { BuildFile, Manifest } from "../../src/core/compiler/lower.js";
import { applyMerges } from "../../src/core/compiler/merge.js";
import { applyShared } from "../../src/core/compiler/shared.js";
import { workspaceListing, workspaceRootFiles } from "../../src/core/compiler/verify.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { BuildAgents } from "../../src/ports/build-agents.js";

export type Workspace = { laidDown: BuildFile[] | undefined; readBack: BuildFile[] | undefined };

export type CheckedBuild = { failures: BuildCheckFailure[]; readBack: BuildFile[] };

const fs = new NodeFileSystem();

async function filesIn(dir: string): Promise<BuildFile[] | undefined> {
  const listing = await workspaceListing(fs, dir, [...workspaceRootFiles, reportPath]);
  if (listing === undefined) return undefined;
  return Promise.all(
    listing.paths.map(async (path) => ({ path, content: await listing.read(path) })),
  );
}

export function recording(agents: BuildAgents, workspace: Workspace): BuildAgents {
  const dirs = new Map<string, string>();
  return {
    open: async (spec) => {
      dirs.set(spec.sessionName, spec.workspaceDir);
      workspace.laidDown ??= await filesIn(spec.workspaceDir);
      await agents.open(spec);
    },
    turn: (name, text, onCall) => agents.turn(name, text, onCall),
    alive: (name) => agents.alive(name),
    close: async (name) => {
      const dir = dirs.get(name);
      if (dir !== undefined && workspace.readBack === undefined) {
        workspace.readBack = await filesIn(dir);
      }
      await agents.close(name);
    },
  };
}

const manifestOf = (files: readonly BuildFile[]): Manifest =>
  JSON.parse(files.find((file) => file.path === "manifest.json")?.content ?? "{}") as Manifest;

export function checkRecorded(workspace: Workspace, report: BuildReport, flow: Flow): CheckedBuild {
  const { laidDown, readBack } = workspace;
  if (laidDown === undefined || readBack === undefined) {
    throw new Error("the workspace was not read at open and close");
  }
  const merged = applyMerges(laidDown, manifestOf(laidDown), report.merges);
  const shared = applyShared(merged.files, merged.manifest, report.shared);
  const failures = checkBuild({
    laidDown: shared.files,
    readBack,
    manifest: shared.manifest,
    flow,
    shared: shared.accepted,
  });
  return { failures, readBack };
}
