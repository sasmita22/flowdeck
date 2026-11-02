import { execFile } from "node:child_process";

export const processArgs = (pid: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(undefined);
      return;
    }
    execFile("ps", ["-ww", "-o", "args=", "-p", String(pid)], (error, stdout) =>
      resolve(error === null ? stdout.trim() : undefined),
    );
  });
