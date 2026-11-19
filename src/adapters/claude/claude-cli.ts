import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../../core/compiler/hook-settings.js";
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

const bypassDialog = /^\s*WARNING: Claude Code running in Bypass Permissions mode\s*$/m;

type FolderDialog = {
  name: string;
  shows: RegExp;
  cursorOnYes: RegExp;
  cursorStuck: string;
  folder?: RegExp;
};

const trustDialog: FolderDialog = {
  name: "trust",
  shows: /Quick safety check|Yes, I trust this folder/,
  cursorOnYes: /^\s*❯\s*(?:\d+\.\s*)?Yes, I trust this folder/m,
  cursorStuck: 'did not move the trust dialog cursor to "Yes, I trust this folder"',
};
const addDirDialog: FolderDialog = {
  name: "add-dir",
  shows: /Adding a new directory|Yes, add it/,
  cursorOnYes: /^\s*❯\s*(?:\d+\.\s*)?Yes, add it/m,
  cursorStuck: 'did not move the add-dir dialog cursor to "Yes, add it"',
  folder: /Adding a new directory:([\s\S]*?)(?:This session|trust)/,
};

function dialogKey(dialog: FolderDialog, pane: string): string {
  const match = dialog.folder?.exec(pane);
  const folder = match?.[1] ?? "";
  return `${dialog.name}:${folder.replace(/\s+/g, "")}`;
}
const folderDialogs = [trustDialog, addDirDialog];
const rule = "────";
const busy = "esc to interrupt";

export type ClaudeSession = { sessionId: string; model?: string; resume?: boolean };

export type ClaudeStartOptions = {
  settingsPath?: string;
  pluginDirs?: readonly string[];
  mcpConfigPath?: string;
  addDir?: readonly string[];
  env?: Record<string, string>;
};

export function claudeCommand(
  { sessionId, model, resume }: ClaudeSession,
  settingsPath?: string,
  pluginDirs: readonly string[] = [],
  mcpConfigPath?: string,
  addDir: readonly string[] = [],
): string {
  const unset = PARENT_SESSION_VARS.map((name) => `-u ${name}`).join(" ");
  const settings = settingsPath === undefined ? "" : ` --settings ${shellQuote(settingsPath)}`;
  const plugin = pluginDirs.map((dir) => ` --plugin-dir ${shellQuote(dir)}`).join("");
  const modelFlag = model === undefined ? "" : ` --model ${shellQuote(model)}`;
  const mcp =
    mcpConfigPath === undefined
      ? ""
      : ` --mcp-config ${shellQuote(mcpConfigPath)} --strict-mcp-config`;
  const added = addDir.map((dir) => ` --add-dir ${shellQuote(dir)}`).join("");
  const session = resume === true ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  return `env ${unset} claude ${session}${modelFlag}${settings}${plugin}${added}${mcp}`;
}

function showsInputBox(pane: string): boolean {
  const lines = pane.split("\n");
  return lines.some(
    (line, i) =>
      line.startsWith("❯") && lines[i - 1]?.startsWith(rule) && lines[i + 1]?.startsWith(rule),
  );
}

const scrolledBorder = /^─+ ↑ \d+ more ─/;

function inputBox(pane: string): string | undefined {
  const lines = pane.split("\n");
  const top = lines.findLastIndex(
    (line, i) =>
      (line.startsWith("❯") && lines[i - 1]?.startsWith(rule)) || scrolledBorder.test(line),
  );
  const end = lines.findIndex((line, i) => i > top && line.startsWith(rule));
  const topLine = lines[top];
  if (topLine === undefined || end === -1) return undefined;
  const firstLine = scrolledBorder.test(topLine) ? [] : [topLine.slice(1)];
  return [...firstLine, ...lines.slice(top + 1, end)].join(" ");
}

const squash = (text: string) => text.replace(/\s+/g, "");

const pasteChipAtEnd = /\[Pastedtext#\d+(\+\d+lines)?\]$/;

function boxHolds(pane: string, prompt: string): boolean {
  const box = inputBox(pane);
  if (box === undefined) return false;
  const held = squash(box);
  return held.includes(squash(prompt).slice(-40)) || pasteChipAtEnd.test(held);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasCode(error: unknown, ...codes: (string | number)[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string | number);
}

export class ClaudeCli {
  private readonly sessions: SessionHost;
  private readonly homeDir: string;
  private readonly configDir: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly dialogSettleMs: number;
  private readonly submitRetryMs: number;
  private readonly ready = new Set<string>();

  constructor(options: {
    sessions: SessionHost;
    homeDir?: string;
    configDir?: string;
    pollIntervalMs?: number;
    readyTimeoutMs?: number;
    dialogSettleMs?: number;
    submitRetryMs?: number;
  }) {
    this.sessions = options.sessions;
    this.homeDir = options.homeDir ?? homedir();
    this.configDir = options.configDir;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.dialogSettleMs = options.dialogSettleMs ?? 1000;
    this.submitRetryMs = options.submitRetryMs ?? 1000;
  }

  async start(
    name: string,
    cwd: string,
    session: ClaudeSession,
    { settingsPath, pluginDirs, mcpConfigPath, addDir, env }: ClaudeStartOptions = {},
  ): Promise<void> {
    this.ready.delete(name);
    await this.sessions.start(
      name,
      cwd,
      claudeCommand(session, settingsPath, pluginDirs, mcpConfigPath, addDir),
      env,
    );
  }

  async waitUntilReady(name: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let shown: string | undefined;
    let dialogSince: number | undefined;
    const answered = new Set<string>();
    for (;;) {
      const pane = await this.sessions.capture(name);
      if (bypassDialog.test(pane)) {
        throw new Error(
          "Claude Code showed its Bypass Permissions warning: consent is missing from the session settings",
        );
      }
      const dialog = folderDialogs.find(({ shows }) => shows.test(pane));
      const key = dialog === undefined ? undefined : dialogKey(dialog, pane);
      if (key !== shown) dialogSince = undefined;
      shown = key;
      if (dialog === undefined || key === undefined) {
        if (showsInputBox(pane)) break;
      } else if (!answered.has(key)) {
        dialogSince ??= Date.now();
        if (Date.now() - dialogSince >= this.dialogSettleMs) {
          answered.add(key);
          await this.answerYes(name, dialog, deadline);
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
    if (text.trim() === "")
      throw new Error(`Claude in session "${name}" was given an empty prompt`);
    if (!this.ready.has(name)) {
      throw new Error(`Claude in session "${name}" is not ready for a prompt`);
    }
    await this.sessions.typeText(name, text);
    const deadline = Date.now() + this.readyTimeoutMs;
    while (!boxHolds(await this.sessions.capture(name), text)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" did not show the prompt in its input box within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
    await this.sessions.sendKey(name, "Enter");
    let lastEnter = Date.now();
    while (boxHolds(await this.sessions.capture(name), text)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" did not submit the prompt within ${this.readyTimeoutMs} ms`,
        );
      }
      if (Date.now() - lastEnter >= this.submitRetryMs) {
        await this.sessions.sendKey(name, "Enter");
        lastEnter = Date.now();
      }
      await sleep(this.pollIntervalMs);
    }
  }

  async interrupt(name: string): Promise<void> {
    await this.sessions.sendKey(name, "Escape");
    const deadline = Date.now() + this.readyTimeoutMs;
    while ((await this.sessions.capture(name)).includes(busy)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" did not stop its turn within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  async findTranscript(sessionId: string): Promise<string | undefined> {
    const projects = join(this.configDir ?? join(this.homeDir, ".claude"), "projects");
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

  private async answerYes(
    name: string,
    { cursorOnYes, cursorStuck }: FolderDialog,
    deadline: number,
  ): Promise<void> {
    await this.sessions.sendKey(name, "Down");
    while (!cursorOnYes.test(await this.sessions.capture(name))) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Claude in session "${name}" ${cursorStuck} within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
    await this.sessions.sendKey(name, "Enter");
  }
}
