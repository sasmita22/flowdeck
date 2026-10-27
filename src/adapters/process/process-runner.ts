import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunner } from "../../ports/process-runner.js";

export class NodeProcessRunner implements ProcessRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        resolve({ code: signal === null ? code : null, stdout, stderr });
      });
    });
  }
}
