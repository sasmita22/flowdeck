import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent, flow, thenWire } from "../fixtures/flow-builders.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
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
  let engine: LiveEngine | undefined;
  let workFolder: string;
  let hash: string;
  let pluginDir: string;
  let withoutSkills: string;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-plugin-")));
    repo = await createTmpRepo({ commit: true });
    engine = liveEngine({ home, repo: repo.path });
    const built = await engine.saveAndBuild(
      flow([agent("plan-step"), agent("plan-checker")], [thenWire("plan-step", "plan-checker")]),
      { name: buildName },
    );
    ({ hash, workFolder } = built);
    pluginDir = join(built.dir, "plugin");
    withoutSkills = join(home, "copy", "plugin");
    await cp(pluginDir, withoutSkills, { recursive: true });
    await rename(join(withoutSkills, "skills"), join(withoutSkills, "skills-renamed"));
    const installed = join(workFolder, ".claude", "skills", "plan-checker");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "SKILL.md"),
      "---\nname: plan-checker\ndescription: An installed skill sharing the agent's name.\n---\nReply OK.\n",
    );
  });

  afterAll(async () => {
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it("lists the build's prompt and its run skill as skills and its agent as an agent", async () => {
    const output = await details(pluginDir, workFolder);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(2\)\s+plan-step, run$/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });

  it("lists no skills once the build's skills folder is gone", async () => {
    const output = await details(withoutSkills, workFolder);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(0\)/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });

  it(
    "offers the agent under the build name next to an installed skill of the same name",
    { timeout: 150_000 },
    async () => {
      const init = await sessionInit(pluginDir, workFolder);
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
