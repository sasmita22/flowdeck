import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";

describe("NodeProcessRunner", () => {
  const runner = new NodeProcessRunner();
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "fd-process-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([0, 2, 1])("reports exit code %i", async (code) => {
    expect((await runner.run("sh", ["-c", `exit ${code}`], cwd)).code).toBe(code);
  });

  it("reports a process killed by a signal as code null", async () => {
    expect((await runner.run("sh", ["-c", "kill -9 $$"], cwd)).code).toBeNull();
  });

  it("captures stdout and stderr", async () => {
    expect(await runner.run("sh", ["-c", "echo out; echo err >&2"], cwd)).toEqual({
      code: 0,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("runs in the given folder", async () => {
    const { stdout } = await runner.run("pwd", [], cwd);

    expect(await realpath(stdout.trim())).toBe(await realpath(cwd));
  });

  it("rejects with ENOENT for a command that does not exist", async () => {
    await expect(runner.run("fd-no-such-command", [], cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the real exit code and all the output when a script prints over 1 MiB", async () => {
    const result = await runner.run("sh", ["-c", "head -c 2000000 /dev/zero | tr '\\0' a"], cwd);

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(2_000_000);
  });

  it("passes args without a shell", async () => {
    expect((await runner.run("echo", ["$HOME"], cwd)).stdout).toBe("$HOME\n");
  });
});
