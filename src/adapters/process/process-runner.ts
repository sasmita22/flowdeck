import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessResult, ProcessRunner } from "../../ports/process-runner.js";
import { processArgs } from "./process-args.js";

const killGraceMs = 2000;
const readBackBytes = 4 * 1024 * 1024;
const rejoinPollMs = 200;
const killed: ProcessResult = { code: null, stdout: "", stderr: "" };

const jobScript =
  'job=$1; shift; echo $$ >"$job/pid"; "$@" >"$job/out" 2>"$job/err"; echo $? >"$job/exit.part"; mv "$job/exit.part" "$job/exit"';

const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readOr = (path: string, fallback: string) =>
  readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  });

const isUtf8Continuation = (byte: number) => (byte & 0xc0) === 0x80;

async function readTail(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size <= readBackBytes) return await file.readFile("utf8");
    const tail = Buffer.alloc(readBackBytes);
    await file.read(tail, 0, readBackBytes, size - readBackBytes);
    let start = 0;
    while (start < tail.length && isUtf8Continuation(tail[start] ?? 0)) start++;
    return `… earlier output trimmed; full output in ${path}\n${tail.toString("utf8", start)}`;
  } finally {
    await file.close();
  }
}

async function finishedJob(job: string): Promise<ProcessResult | undefined> {
  const exit = await readOr(join(job, "exit"), "");
  if (exit === "") return undefined;
  return {
    code: Number(exit.trim()),
    stdout: await readTail(join(job, "out")),
    stderr: await readTail(join(job, "err")),
  };
}

const isJobWrapper = async (pid: number, job: string) =>
  (await processArgs(pid))?.includes(job) === true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class NodeProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    job?: string,
  ): Promise<ProcessResult> {
    if (signal?.aborted === true) return Promise.resolve(killed);
    return job === undefined
      ? this.runAttached(command, args, cwd, signal)
      : this.runJob(command, args, cwd, job, signal);
  }

  async rejoin(job: string, signal?: AbortSignal): Promise<ProcessResult | undefined> {
    const pid = Number((await readOr(join(job, "pid"), "")).trim());
    if (!(await isJobWrapper(pid, job))) return finishedJob(job);
    let aborted = false;
    const killIfOurs = async (signalName: NodeJS.Signals) => {
      if (await isJobWrapper(pid, job)) signalGroup(pid, signalName);
    };
    const kill = () => {
      aborted = true;
      void killIfOurs("SIGTERM");
      setTimeout(() => void killIfOurs("SIGKILL"), killGraceMs).unref();
    };
    signal?.addEventListener("abort", kill, { once: true });
    try {
      for (;;) {
        const finished = await finishedJob(job);
        if (aborted) return killed;
        if (finished !== undefined) return finished;
        if (!isAlive(pid)) return await finishedJob(job);
        await sleep(rejoinPollMs);
      }
    } finally {
      signal?.removeEventListener("abort", kill);
    }
  }

  private async runJob(
    command: string,
    args: readonly string[],
    cwd: string,
    job: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    await mkdir(job, { recursive: true });
    const child = spawn("sh", ["-c", jobScript, "sh", job, command, ...args], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    let aborted = false;
    let forceKill: NodeJS.Timeout | undefined;
    const kill = () => {
      aborted = true;
      signalGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), killGraceMs);
    };
    signal?.addEventListener("abort", kill, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
    } finally {
      signal?.removeEventListener("abort", kill);
      clearTimeout(forceKill);
    }
    if (aborted) return killed;
    return (await finishedJob(job)) ?? killed;
  }

  private runAttached(
    command: string,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let forceKill: NodeJS.Timeout | undefined;
      const kill = () => {
        signalGroup(child.pid, "SIGTERM");
        forceKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), killGraceMs);
      };
      const settle = () => {
        signal?.removeEventListener("abort", kill);
        clearTimeout(forceKill);
      };
      signal?.addEventListener("abort", kill, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => {
        settle();
        reject(error);
      });
      child.on("close", (code, closedBy) => {
        settle();
        resolve({ code: closedBy === null ? code : null, stdout, stderr });
      });
    });
  }
}
