import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunner } from "../../ports/process-runner.js";

const killGraceMs = 2000;
const killed: ProcessResult = { code: null, stdout: "", stderr: "" };

const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
};

export class NodeProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (signal?.aborted === true) return Promise.resolve(killed);
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
