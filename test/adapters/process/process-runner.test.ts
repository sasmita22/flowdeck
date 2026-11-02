import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it("kills the command when its signal aborts, and reports it as killed", async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 100);

    const result = await runner.run("sleep", ["30"], cwd, abort.signal);

    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills the script's whole process group when its signal aborts", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pidFile = join(cwd, "grandchild.pid");
    setTimeout(() => abort.abort(), 300);

    const result = await runner.run(
      "sh",
      ["-c", `sh -c 'echo $$ > ${pidFile}; exec sleep 30'; echo x`],
      cwd,
      abort.signal,
    );

    expect(result).toEqual({ code: null, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(2000);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    await expect.poll(() => isAlive(grandchild), { timeout: 1000 }).toBe(false);
  });

  it("kills a script that ignores SIGTERM once the grace period is over", async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 100);

    const result = await runner.run(
      "sh",
      ["-c", "trap '' TERM; sleep 30; echo x"],
      cwd,
      abort.signal,
    );

    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not start a command whose signal has already aborted", async () => {
    const abort = new AbortController();
    abort.abort();

    expect(
      (await runner.run("sh", ["-c", "echo ran > ran.txt"], cwd, abort.signal)).code,
    ).toBeNull();
    await expect(realpath(join(cwd, "ran.txt"))).rejects.toThrow();
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
