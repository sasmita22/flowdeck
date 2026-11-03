import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realDeps } from "../../src/cli/main.js";
import { agent, flow, prompt, thenWire } from "../fixtures/flow-builders.js";
import { cliBuild, plannedWorkspace, type PlannedWorkspace } from "../fixtures/cli-build.js";
import { removeClaudeSessions } from "../fixtures/live-claude.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const buildName = "live-plugin";

type Init = {
  type?: string;
  subtype?: string;
  agents?: string[];
  skills?: string[];
  slash_commands?: string[];
};

const details = async (pluginDir: string, cwd: string): Promise<string> => {
  const { stdout } = await run(
    "claude",
    ["--plugin-dir", pluginDir, "plugin", "details", buildName],
    { cwd, timeout: 60_000 },
  );
  return stdout;
};

const inventory = (output: string, section: string): string =>
  output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${section} (`)) ?? "";

const sessionInit = async (pluginDir: string, cwd: string): Promise<Init> => {
  const { stdout } = await run(
    "claude",
    [
      "--plugin-dir",
      pluginDir,
      "--model",
      "haiku",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      "-p",
      "Reply OK.",
    ],
    { cwd, timeout: 120_000 },
  );
  const init = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Init)
    .find((event) => event.type === "system" && event.subtype === "init");
  if (init === undefined) throw new Error(`no init event in:\n${stdout}`);
  return init;
};

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("build plugin in plain claude", () => {
  let home: string;
  let repo: TmpRepo;
  let workspace: PlannedWorkspace;
  let hash: string;
  let pluginDir: string;
  let withoutCommands: string;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-plugin-")));
    repo = await createTmpRepo({ commit: true });
    workspace = plannedWorkspace(home, repo.path);
    ({ hash } = await cliBuild(
      flow([prompt("plan-step"), agent("plan-checker")], [thenWire("plan-step", "plan-checker")]),
      { name: buildName, repo: repo.path },
      workspace,
      { ...realDeps(), env: { ...process.env, FLOWDECK_HOME: home } },
    ));
    pluginDir = join(workspace.dir, "plugin");
    withoutCommands = join(home, "copy", "plugin");
    await cp(pluginDir, withoutCommands, { recursive: true });
    await rename(join(withoutCommands, "commands"), join(withoutCommands, "commands-renamed"));
    const installed = join(workspace.workFolder, ".claude", "skills", "plan-checker");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "SKILL.md"),
      "---\nname: plan-checker\ndescription: An installed skill sharing the agent's name.\n---\nReply OK.\n",
    );
  });

  afterAll(async () => {
    await removeClaudeSessions(workspace.workFolder, []);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it("lists the build's prompt as a skill and its agent as an agent", async () => {
    const output = await details(pluginDir, workspace.workFolder);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(1\)\s+plan-step$/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });

  it("lists no skills once the build's commands folder is gone", async () => {
    const output = await details(withoutCommands, workspace.workFolder);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(0\)/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });

  it(
    "offers the agent under the build name next to an installed skill of the same name",
    { timeout: 150_000 },
    async () => {
      const init = await sessionInit(pluginDir, workspace.workFolder);
      const report = JSON.stringify(init);
      const named = [
        ...(init.agents ?? []),
        ...(init.skills ?? []),
        ...(init.slash_commands ?? []),
      ];

      expect(init.agents, report).toContain(`${buildName}:plan-checker`);
      expect([...(init.skills ?? []), ...(init.slash_commands ?? [])], report).toContain(
        "plan-checker",
      );
      expect(
        named.filter((name) => name.startsWith(`${hash}:`)),
        report,
      ).toEqual([]);
    },
  );
});
