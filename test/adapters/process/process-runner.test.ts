import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

function killGroupIfAny(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

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

describe("NodeProcessRunner jobs", () => {
  const runner = new NodeProcessRunner();
  let cwd: string;
  let job: string;
  const pidOf = async () => Number(await readFile(join(job, "pid"), "utf8").catch(() => "0"));

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "fd-job-")));
    job = join(cwd, "jobs", "s1-4");
  });

  afterEach(async () => {
    killGroupIfAny(await pidOf());
    await rm(cwd, { recursive: true, force: true });
  });

  it("cleanup does not throw for a group whose only member is an unreaped zombie", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    process.kill(-pid, "SIGKILL");
    const deadline = Date.now() + 2000;
    while (
      !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
        .trim()
        .startsWith("Z")
    ) {
      if (Date.now() > deadline) throw new Error(`process ${pid} never became a zombie`);
    }

    expect(() => killGroupIfAny(pid)).not.toThrow();
    await exited;
  });

  it("gives the code and output like a plain run, and keeps them in the job's folder", async () => {
    const result = await runner.run(
      "sh",
      ["-c", "echo out; echo err >&2; exit 3"],
      cwd,
      undefined,
      job,
    );

    expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
    expect(await readFile(join(job, "exit"), "utf8")).toBe("3\n");
  });

  it("runs in the given folder and passes args without a shell", async () => {
    const result = await runner.run("pwd", [], cwd, undefined, job);
    const again = await runner.run("echo", ["a b", "$HOME"], cwd, undefined, `${job}-2`);

    expect(result.stdout).toBe(`${cwd}\n`);
    expect(again.stdout).toBe("a b $HOME\n");
  });

  it("keeps a job's real exit code and all its output when it prints over 1 MiB", async () => {
    const result = await runner.run(
      "sh",
      ["-c", "head -c 2000000 /dev/zero | tr '\\0' a"],
      cwd,
      undefined,
      job,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(2_000_000);
    expect((await readFile(join(job, "out"), "utf8")).length).toBe(2_000_000);
  });

  it("keeps all of a job's output on disk but reads back only the last 4 MiB of each stream, marked", async () => {
    const fourMiB = 4 * 1024 * 1024;
    const result = await runner.run(
      "sh",
      [
        "-c",
        "head -c 5000000 /dev/zero | tr '\\0' a; printf end; head -c 5000000 /dev/zero | tr '\\0' b >&2",
      ],
      cwd,
      undefined,
      job,
    );
    const marker = (stream: string) =>
      `… earlier output trimmed; full output in ${join(job, stream)}\n`;

    expect(result.code).toBe(0);
    expect((await readFile(join(job, "out"), "utf8")).length).toBe(5_000_003);
    expect((await readFile(join(job, "err"), "utf8")).length).toBe(5_000_000);
    expect(result.stdout.startsWith(marker("out"))).toBe(true);
    expect(result.stdout.slice(marker("out").length)).toHaveLength(fourMiB);
    expect(result.stdout.endsWith("aend")).toBe(true);
    expect(result.stderr).toBe(marker("err") + "b".repeat(fourMiB));
    expect(await new NodeProcessRunner().rejoin(job)).toEqual(result);
  });

  it("rejoins a finished job with its result, from another runner", async () => {
    await runner.run("sh", ["-c", "echo done; exit 2"], cwd, undefined, job);

    expect(await new NodeProcessRunner().rejoin(job)).toEqual({
      code: 2,
      stdout: "done\n",
      stderr: "",
    });
  });

  it("rejoins a job still running and answers once it exits", async () => {
    void runner.run(
      "sh",
      [
        "-c",
        "n=0; while [ ! -f go ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done; echo late",
      ],
      cwd,
      undefined,
      job,
    );
    await expect.poll(pidOf).toBeGreaterThan(0);

    const rejoined = new NodeProcessRunner().rejoin(job);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(join(cwd, "go"), "");

    expect(await rejoined).toEqual({ code: 0, stdout: "late\n", stderr: "" });
  });

  it("keeps a job running after the process that started it is killed, and rejoins it", async () => {
    const adapter = join(process.cwd(), "src/adapters/process/process-runner.ts");
    const starter = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import(${JSON.stringify(adapter)}).then(({ NodeProcessRunner }) => new NodeProcessRunner().run("sh", ["-c", "n=0; while [ ! -f go ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done; echo survived"], ${JSON.stringify(cwd)}, undefined, ${JSON.stringify(job)}))`,
      ],
      { stdio: "ignore" },
    );
    const starterExit = new Promise((resolve) => starter.once("exit", resolve));
    try {
      await expect.poll(pidOf, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      starter.kill("SIGKILL");
      await starterExit;
    }

    expect(isAlive(await pidOf())).toBe(true);
    await writeFile(join(cwd, "go"), "");
    expect(await runner.rejoin(job)).toEqual({ code: 0, stdout: "survived\n", stderr: "" });
  });

  it("answers nothing for a job that never started, or died without an exit code", async () => {
    expect(await runner.rejoin(join(cwd, "jobs", "never"))).toBeUndefined();
    void runner.run("sleep", ["30"], cwd, undefined, job);
    await expect.poll(pidOf).toBeGreaterThan(0);
    process.kill(-(await pidOf()), "SIGKILL");

    expect(await new NodeProcessRunner().rejoin(job)).toBeUndefined();
  });

  it("kills a rejoined job's process group when its signal aborts, and reports it as killed", async () => {
    void runner.run("sleep", ["30"], cwd, undefined, job);
    await expect.poll(pidOf).toBeGreaterThan(0);
    const pid = await pidOf();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);

    expect(await new NodeProcessRunner().rejoin(job, abort.signal)).toEqual({
      code: null,
      stdout: "",
      stderr: "",
    });
    await expect.poll(() => isAlive(pid)).toBe(false);
  });

  it("does not wait on or kill a live process that took over the job's pid", async () => {
    const foreign = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const foreignPid = foreign.pid ?? 0;
    try {
      await mkdir(job, { recursive: true });
      await writeFile(join(job, "pid"), `${foreignPid}\n`);
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      const started = Date.now();

      expect(await runner.rejoin(job)).toBeUndefined();
      expect(await runner.rejoin(job, abort.signal)).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(Date.now() - started).toBeLessThan(2000);
      expect(isAlive(foreignPid)).toBe(true);
    } finally {
      process.kill(-foreignPid, "SIGKILL");
    }
  });

  it("does not start a job whose signal aborts while its folder is being made", async () => {
    const abort = new AbortController();
    const running = runner.run("sh", ["-c", "echo started > marker"], cwd, abort.signal, job);
    abort.abort();

    expect(await running).toEqual({ code: null, stdout: "", stderr: "" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await readFile(join(cwd, "marker"), "utf8").catch(() => "never started")).toBe(
      "never started",
    );
  });

  it("reports a job killed by its abort signal as code null", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);

    expect((await runner.run("sleep", ["30"], cwd, abort.signal, job)).code).toBeNull();
  });
});
