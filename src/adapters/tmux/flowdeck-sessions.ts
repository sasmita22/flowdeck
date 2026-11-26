import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const socketVariable = "FLOWDECK_SOCK=";

function socketFolder(): string {
  return join(process.env["TMUX_TMPDIR"] || "/tmp", `tmux-${process.getuid?.()}`);
}

export async function flowdeckSessionNames(): Promise<string[]> {
  try {
    return (await readdir(socketFolder())).filter((name) => name.startsWith("fd-"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function sessionSocketPath(name: string): Promise<string | undefined> {
  const { stdout } = await run("tmux", ["-L", name, "show-environment", "-t", `=${name}`]);
  const line = stdout.split("\n").find((entry) => entry.startsWith(socketVariable));
  return line?.slice(socketVariable.length);
}
