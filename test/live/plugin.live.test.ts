import { execFile } from "node:child_process";
import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { build } from "../../src/core/compiler/build.js";
import { agent, flow, prompt, thenWire } from "../fixtures/flow-builders.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));

const details = async (pluginDir: string, hash: string, cwd: string): Promise<string> => {
  const { stdout } = await run("claude", ["--plugin-dir", pluginDir, "plugin", "details", hash], {
    cwd,
    timeout: 60_000,
  });
  return stdout;
};

const inventory = (output: string, section: string): string =>
  output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${section} (`)) ?? "";

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("build folder in plain claude", () => {
  let tmp: string;
  let hash: string;
  let buildDir: string;
  let withoutCommands: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd-plugin-"));
    const result = await build(
      flow([prompt("plan-step"), agent("plan-checker")], [thenWire("plan-step", "plan-checker")]),
      {
        fs: new NodeFileSystem(),
        home: join(tmp, "home"),
        hooks: { nodePath: process.execPath, hookScriptPath },
      },
    );
    if (!result.ok) throw new Error("build failed");
    hash = result.hash;
    buildDir = result.dir;
    withoutCommands = join(tmp, "copy", hash);
    await cp(buildDir, withoutCommands, { recursive: true });
    await rename(join(withoutCommands, "commands"), join(withoutCommands, "commands-renamed"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("lists the build's prompt as a skill and its agent as an agent", async () => {
    const output = await details(buildDir, hash, tmp);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(1\)\s+plan-step$/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });

  it("lists no skills once the build's commands folder is gone", async () => {
    const output = await details(withoutCommands, hash, tmp);

    expect(inventory(output, "Skills")).toMatch(/^Skills \(0\)/);
    expect(inventory(output, "Agents")).toMatch(/^Agents \(1\)\s+plan-checker$/);
  });
});
