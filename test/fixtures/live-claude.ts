import { execFile } from "node:child_process";
import { readFile, rm, rmdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ContentBlock = { type?: string; is_error?: boolean };
export type TranscriptEntry = {
  message?: { content?: unknown };
  attachment?: { type?: string; decision?: string; hookEvent?: string };
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

export async function readLines<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

export function tokenResults(entries: TranscriptEntry[], token: string): ContentBlock[] {
  return entries
    .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
    .filter((block: ContentBlock) => block.type === "tool_result" && block.is_error !== true)
    .filter((block) => JSON.stringify(block).includes(token));
}

export async function killTmuxServer(socketName: string): Promise<void> {
  try {
    await run("tmux", ["-L", socketName, "kill-server"]);
    console.error(`killed a tmux server left on ${socketName}`);
  } catch (error) {
    if (!hasCode(error, 1)) throw error;
  }
  const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  await rm(join(socketFolder, socketName), { force: true });
}

async function claudeRunning(sessionId: string): Promise<boolean> {
  try {
    await run("pgrep", ["-f", `session-id ${sessionId}`]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

async function waitForClaudeToExit(sessionId: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    if (!(await claudeRunning(sessionId))) return;
    await sleep(100);
  }
  throw new Error(`claude for session ${sessionId} did not exit`);
}

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await rmdir(folder);
  } catch (error) {
    if (!hasCode(error, "ENOTEMPTY", "ENOENT")) throw error;
  }
}

export async function removeClaudeSessions(repoPath: string, sessionIds: string[]): Promise<void> {
  const slug = repoPath.replace(/[^a-zA-Z0-9]/g, "-");
  const projectFolder = join(homedir(), ".claude", "projects", slug);
  for (const sessionId of sessionIds) {
    await waitForClaudeToExit(sessionId);
    await rm(join(projectFolder, `${sessionId}.jsonl`), { force: true });
    await rm(join(projectFolder, sessionId), { recursive: true, force: true });
    for (const folder of ["session-env", "file-history"]) {
      await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
    }
  }
  await removeIfEmpty(join(projectFolder, "memory"));
  await removeIfEmpty(projectFolder);
  await rm(join("/private/tmp", `claude-${userInfo().uid}`, slug), {
    recursive: true,
    force: true,
  });
}
