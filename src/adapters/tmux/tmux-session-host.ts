import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { SessionHost } from "../../ports/session-host.js";

const run = promisify(execFile);
const sessionName = /^fd-[A-Za-z0-9_-]+$/;
const noServer = /no server running on|error connecting to/;

export function assertSessionName(name: string): void {
  if (!sessionName.test(name)) {
    throw new Error(`Invalid session name "${name}": must match ${sessionName.source}`);
  }
}

function stderrOf(error: unknown): string {
  return error instanceof Error && "stderr" in error ? String(error.stderr) : "";
}

function exitedWithOne(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 1;
}

export class TmuxSessionHost implements SessionHost {
  constructor(private readonly options: { socketName?: string } = {}) {}

  async start(name: string, cwd: string, command: string): Promise<void> {
    assertSessionName(name);
    if (!(await this.isFolder(cwd))) throw new Error(`Working folder "${cwd}" is not a folder`);
    try {
      await this.tmux("new-session", "-d", "-s", name, "-c", cwd, command);
    } catch (error) {
      if (stderrOf(error).includes("duplicate session")) {
        throw new Error(`Session "${name}" already exists`, { cause: error });
      }
      throw error;
    }
  }

  async has(name: string): Promise<boolean> {
    assertSessionName(name);
    try {
      await this.tmux("has-session", "-t", `=${name}`);
      return true;
    } catch (error) {
      if (exitedWithOne(error)) return false;
      throw error;
    }
  }

  async stop(name: string): Promise<void> {
    if (!(await this.has(name))) throw new Error(`Session "${name}" does not exist`);
    await this.tmux("kill-session", "-t", `=${name}`);
  }

  async list(): Promise<string[]> {
    try {
      const stdout = await this.tmux("list-sessions", "-F", "#{session_name}");
      return stdout.split("\n").filter((name) => name.startsWith("fd-"));
    } catch (error) {
      if (noServer.test(stderrOf(error))) return [];
      throw error;
    }
  }

  private async isFolder(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Working folder "${path}" does not exist`, { cause: error });
      }
      throw error;
    }
  }

  private async tmux(...args: string[]): Promise<string> {
    const socket = this.options.socketName ? ["-L", this.options.socketName] : [];
    const { stdout } = await run("tmux", [...socket, ...args]);
    return stdout;
  }
}
