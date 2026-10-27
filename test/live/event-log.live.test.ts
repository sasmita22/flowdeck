import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { writeHookSettings } from "../../src/adapters/claude/write-hook-settings.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { EventLog } from "../../src/adapters/jsonl/event-log.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { hookSettings } from "../../src/core/compiler/hook-settings.js";
import { waitForTurnEnd } from "../../src/core/run/turns.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const maxSocketPath = 104;
const turnTimeoutMs = 90_000;

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

type LogLine = { kind?: string; tool_name?: string | null; agent_type?: string | null };

async function readEventLog(path: string): Promise<LogLine[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as LogLine);
}

function preToolUseReads(lines: LogLine[]): LogLine[] {
  return lines.filter((line) => line.kind === "PreToolUse" && line.tool_name === "Read");
}

function generalPurposeSubagentStops(lines: LogLine[]): LogLine[] {
  return lines.filter(
    (line) => line.kind === "SubagentStop" && line.agent_type === "general-purpose",
  );
}

function stopAfterSubagent(lines: LogLine[]): boolean {
  const subagentStop = lines.findIndex((line) => generalPurposeSubagentStops([line]).length > 0);
  return subagentStop !== -1 && lines.slice(subagentStop + 1).some((line) => line.kind === "Stop");
}

async function logWithin(
  path: string,
  done: (lines: LogLine[]) => boolean,
  ms: number,
): Promise<LogLine[]> {
  const deadline = Date.now() + ms;
  let lines = await readEventLog(path);
  while (!done(lines) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    lines = await readEventLog(path);
  }
  return lines;
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

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await rmdir(folder);
  } catch (error) {
    if (!hasCode(error, "ENOTEMPTY", "ENOENT")) throw error;
  }
}

async function waitForClaudeToExit(sessionId: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    if (!(await claudeRunning(sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`claude for session ${sessionId} did not exit`);
}

async function removeClaudeTmp(repoPath: string): Promise<void> {
  const slug = repoPath.replace(/[^a-zA-Z0-9]/g, "-");
  await rm(join("/private/tmp", `claude-${userInfo().uid}`, slug), {
    recursive: true,
    force: true,
  });
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("event log with real claude", () => {
  const socketName = `fd-live-events-${process.pid}`;
  const sessions = new TmuxSessionHost({ socketName });
  const cli = new ClaudeCli({ sessions });
  let home: string;
  let socketPath: string;
  let server: HookSocketServer;
  let repo: TmpRepo;
  let started: { name: string; sessionId: string; unwatch: () => void }[];

  async function startWatchedClaude(label: string) {
    const sessionId = randomUUID();
    const name = `fd-live-${process.pid}-${label}`;
    const logPath = join(home, "runs", label, "events.jsonl");
    const unwatch = new EventLog({ events: server, path: logPath, runId: label }).watch(sessionId);
    started.push({ name, sessionId, unwatch });
    const settingsPath = await writeHookSettings(
      join(home, "sessions", sessionId),
      hookSettings({ nodePath: process.execPath, hookScriptPath }),
    );
    await cli.start(
      name,
      repo.path,
      { sessionId, model: "haiku" },
      { settingsPath, env: { FLOWDECK_SOCK: socketPath } },
    );
    await cli.waitUntilReady(name);
    return { name, sessionId, logPath };
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    socketPath = join(home, "hook.sock");
    if (socketPath.length > maxSocketPath) {
      throw new Error(`Socket path "${socketPath}" is longer than ${maxSocketPath} characters`);
    }
    server = new HookSocketServer({ socketPath });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    await rm(join(socketFolder, socketName), { force: true });
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    repo = await createTmpRepo();
    started = [];
  });

  afterEach(async () => {
    for (const { name, unwatch } of started) {
      unwatch();
      if (await sessions.has(name)) await sessions.stop(name);
    }
    for (const { sessionId } of started) {
      await waitForClaudeToExit(sessionId);
      const transcript = await cli.findTranscript(sessionId);
      if (transcript) {
        await rm(transcript);
        await rm(join(dirname(transcript), sessionId), { recursive: true, force: true });
        await removeIfEmpty(join(dirname(transcript), "memory"));
        await removeIfEmpty(dirname(transcript));
      }
      for (const folder of ["session-env", "file-history"]) {
        await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
      }
    }
    await removeClaudeTmp(repo.path);
    await repo.cleanup();
  }, 60_000);

  it(
    "AT-1 logs exactly two PreToolUse Read lines for a two-file read",
    {
      timeout: 180_000,
    },
    async () => {
      for (const file of ["a.txt", "b.txt"]) {
        await writeFile(join(repo.path, file), `${file}\n`);
      }
      const { name, sessionId, logPath } = await startWatchedClaude("at1");

      const turnEnd = waitForTurnEnd(server, sessionId, turnTimeoutMs);
      await cli.sendPrompt(name, "Read a.txt and b.txt, then reply DONE");
      await turnEnd;
      const lines = await readEventLog(logPath);

      expect(preToolUseReads(lines)).toHaveLength(2);
    },
  );

  it(
    "AT-2 logs exactly one general-purpose SubagentStop line for one subagent",
    {
      timeout: 180_000,
    },
    async () => {
      const { name, logPath } = await startWatchedClaude("at2");

      await cli.sendPrompt(
        name,
        "Use the Agent tool to start one general-purpose subagent that replies OK, then reply DONE",
      );
      const lines = await logWithin(logPath, stopAfterSubagent, turnTimeoutMs);

      expect(stopAfterSubagent(lines)).toBe(true);
      expect(generalPurposeSubagentStops(lines)).toHaveLength(1);
    },
  );
});
