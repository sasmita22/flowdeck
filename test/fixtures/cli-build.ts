import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { prepareKit } from "../../src/adapters/node-fs/kit-copy.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { newBuildSessionName } from "../../src/core/compiler/build-session.js";
import type { Flow } from "../../src/core/flow/schema.js";
import { FakeBuildAgents } from "../fakes/fake-build-agents.js";

export type PlannedWorkspace = { id: string; dir: string; workFolder: string };

export function plannedWorkspace(home: string, repo: string): PlannedWorkspace {
  const id = randomUUID();
  const dir = join(home, "workspaces", id);
  return { id, dir, workFolder: join(dir, basename(repo)) };
}

export async function cliBuild(
  flow: Flow,
  request: { name: string; repo: string; vars?: string[] },
  workspace: PlannedWorkspace,
  deps: CliDeps,
): Promise<{ hash: string }> {
  const home = deps.env.FLOWDECK_HOME;
  if (home === undefined) throw new Error("cliBuild needs FLOWDECK_HOME");
  const flowPath = join(home, `${request.name}.flow.json`);
  await writeFile(flowPath, JSON.stringify(flow));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const vars = (request.vars ?? []).flatMap((entry) => ["--var", entry]);
  const code = await runCli(
    ["build", flowPath, "--name", request.name, "--repo", request.repo, ...vars],
    {
      ...deps,
      build: {
        agents: new FakeBuildAgents({ fs: deps.fs }),
        kit: (kitHome) => prepareKit({ sourceDir: "kit", home: kitHome }),
        guardScriptPath: deps.build.guardScriptPath,
        sessionName: () => newBuildSessionName(randomUUID),
      },
      newId: () => workspace.id,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );
  const hash = stdout.find((line) => line.startsWith("hash "))?.slice("hash ".length);
  if (code !== 0 || hash === undefined || !stdout.includes(`dir ${workspace.dir}`)) {
    throw new Error(`flowdeck build exited ${code}:\n${[...stdout, ...stderr].join("\n")}`);
  }
  return { hash };
}
