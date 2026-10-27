import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionHost } from "../../ports/session-host.js";

export const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
] as const;

const trustDialog = /Quick safety check|Yes, I trust this folder/;
const cursorOnYes = /^\s*❯\s*(?:\d+\.\s*)?Yes, I trust this folder/m;
const rule = "────";

export type ClaudeSession = { sessionId: string; model: string };

export function claudeCommand({ sessionId, model }: ClaudeSession): string {
  const unset = PARENT_SESSION_VARS.map((name) => `-u ${name}`).join(" ");
  return `env ${unset} claude --session-id ${sessionId} --model ${model}`;
}

export function replyLine(token: string): RegExp {
  return new RegExp(`^⏺ ${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
}

function showsInputBox(pane: string): boolean {
  const lines = pane.split("\n");
  return lines.some(
    (line, i) =>
      line.startsWith("❯") && lines[i - 1]?.startsWith(rule) && lines[i + 1]?.startsWith(rule),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasCode(error: unknown, ...codes: (string | number)[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string | number);
}

export class ClaudeCli {
  private readonly sessions: SessionHost;
  private readonly homeDir: string;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly dialogSettleMs: number;
  private readonly ready = new Set<string>();

  constructor(options: {
    sessions: SessionHost;
    homeDir?: string;
    pollIntervalMs?: number;
    readyTimeoutMs?: number;
    dialogSettleMs?: number;
  }) {
    this.sessions = options.sessions;
    this.homeDir = options.homeDir ?? homedir();
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.dialogSettleMs = options.dialogSettleMs ?? 1000;
  }

  async start(name: string, cwd: string, session: ClaudeSession): Promise<void> {
    this.ready.delete(name);
    await this.sessions.start(name, cwd, claudeCommand(session));
  }

  async waitUntilReady(name: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let dialogSince: number | undefined;
    let answeredDialog = false;
    for (;;) {
      const pane = await this.sessions.capture(name);
      if (!trustDialog.test(pane)) {
        dialogSince = undefined;
        if (showsInputBox(pane)) break;
      } else if (!answeredDialog) {
        dialogSince ??= Date.now();
        if (Date.now() - dialogSince >= this.dialogSettleMs) {
          answeredDialog = true;
          await this.trustFolder(name, deadline);
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" was not ready within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
    this.ready.add(name);
  }

  async sendPrompt(name: string, text: string): Promise<void> {
    if (!this.ready.has(name)) {
      throw new Error(`Claude in session "${name}" is not ready for a prompt`);
    }
    await this.sessions.sendText(name, text);
  }

  async waitForReply(name: string, matcher: RegExp, timeoutMs: number): Promise<string> {
    const pane = await this.poll(name, timeoutMs, async (pane) => matcher.test(pane));
    if (pane === undefined) throw new Error(`No reply in session "${name}" within ${timeoutMs} ms`);
    return pane;
  }

  async findTranscript(sessionId: string): Promise<string | undefined> {
    const projects = join(this.homeDir, ".claude", "projects");
    let folders: string[];
    try {
      folders = await readdir(projects);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    for (const folder of folders) {
      const transcript = join(projects, folder, `${sessionId}.jsonl`);
      try {
        await access(transcript);
        return transcript;
      } catch (error) {
        if (!hasCode(error, "ENOENT", "ENOTDIR")) throw error;
      }
    }
    return undefined;
  }

  private async trustFolder(name: string, deadline: number): Promise<void> {
    await this.sessions.sendKey(name, "Down");
    while (!cursorOnYes.test(await this.sessions.capture(name))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" did not move the trust dialog cursor to "Yes, I trust this folder" within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
    await this.sessions.sendKey(name, "Enter");
  }

  private async poll(
    name: string,
    timeoutMs: number,
    done: (pane: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pane = await this.sessions.capture(name);
      if (await done(pane)) return pane;
      if (Date.now() >= deadline) return undefined;
      await sleep(this.pollIntervalMs);
    }
  }
}
