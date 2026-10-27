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
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { hookSettings } from "../../src/core/compiler/hook-settings.js";
import { waitForTurnEnd, type TurnEndEvent } from "../../src/core/run/turns.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const maxSocketPath = 104;

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

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

type TranscriptEntry = { type?: string; message?: { content?: unknown } };
type ContentBlock = { type?: string; text?: string };

async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  const lines = (await readFile(path, "utf8")).split("\n").slice(0, -1);
  return lines.map((line) => JSON.parse(line) as TranscriptEntry);
}

function blocksOf(entry: TranscriptEntry): ContentBlock[] {
  const content = entry.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function lastAssistantText(entries: TranscriptEntry[]): string | undefined {
  const last = entries.findLast((entry) => entry.type === "assistant");
  if (!last) return undefined;
  return blocksOf(last)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

function toolResultCount(entries: TranscriptEntry[]): number {
  return entries.flatMap(blocksOf).filter((block) => block.type === "tool_result").length;
}

async function lastAssistantTextWithin(path: string, expected: string, ms: number) {
  const deadline = Date.now() + ms;
  let text = lastAssistantText(await readTranscript(path));
  while (text !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    text = lastAssistantText(await readTranscript(path));
  }
  return text;
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("turn end with real claude", () => {
  const socketName = `fd-live-turns-${process.pid}`;
  const sessions = new TmuxSessionHost({ socketName });
  const cli = new ClaudeCli({ sessions });
  let home: string;
  let socketPath: string;
  let server: HookSocketServer;
  let repo: TmpRepo;
  let started: { name: string; sessionId: string }[];

  async function startClaude(label: string, observeToolUse = false) {
    const sessionId = randomUUID();
    const name = `fd-live-${process.pid}-${label}`;
    started.push({ name, sessionId });
    const settings = hookSettings({ nodePath: process.execPath, hookScriptPath });
    const observed = { hooks: { ...settings.hooks, PostToolUse: settings.hooks.Stop } };
    const settingsPath = await writeHookSettings(
      join(home, "sessions", sessionId),
      observeToolUse ? observed : settings,
    );
    await cli.start(
      name,
      repo.path,
      { sessionId, model: "haiku" },
      { settingsPath, env: { FLOWDECK_SOCK: socketPath } },
    );
    return { name, sessionId };
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
    for (const { name } of started) {
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
      await rm(join(homedir(), ".claude", "session-env", sessionId), {
        recursive: true,
        force: true,
      });
    }
    await repo.cleanup();
  }, 60_000);

  it(
    "AT-1 resolves on Stop with the reply, which then lands in the transcript",
    {
      timeout: 180_000,
    },
    async () => {
      const { name, sessionId } = await startClaude("at1");
      await cli.waitUntilReady(name);

      const turnEnd = waitForTurnEnd(server, sessionId, 60_000);
      await cli.sendPrompt(name, "Reply with exactly: OK");
      const stop = await turnEnd;

      expect(stop.sessionId).toBe(sessionId);
      expect(String(stop.payload["last_assistant_message"]).trim()).toBe("OK");
      const transcriptPath = String(stop.payload["transcript_path"]);
      expect(await lastAssistantTextWithin(transcriptPath, "OK", 5000)).toBe("OK");
      expect(await cli.findTranscript(sessionId)).toBeDefined();
    },
  );

  it("AT-2 resolves only after the third tool result", { timeout: 180_000 }, async () => {
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(repo.path, file), `${file}\n`);
    }
    const { name, sessionId } = await startClaude("at2", true);
    await cli.waitUntilReady(name);
    let toolUses = 0;
    const unsubscribe = server.subscribe("PostToolUse", sessionId, () => (toolUses += 1));

    const turnEnd = waitForTurnEnd(server, sessionId, 90_000);
    await cli.sendPrompt(name, "Read a.txt, b.txt and c.txt, then reply DONE");
    const stop = await turnEnd;
    const toolUsesAtStop = toolUses;
    const entries = await readTranscript(String(stop.payload["transcript_path"]));
    unsubscribe();

    expect(toolUsesAtStop).toBe(3);
    expect(toolResultCount(entries)).toBe(3);
  });

  it("AT-3 resolves only the prompted session", { timeout: 180_000 }, async () => {
    const a = await startClaude("at3-a");
    const b = await startClaude("at3-b");
    await Promise.all([cli.waitUntilReady(a.name), cli.waitUntilReady(b.name)]);
    const order: string[] = [];

    const aTurnEnd = waitForTurnEnd(server, a.sessionId, 20_000).then(
      (event) => (order.push("A resolved"), event),
      (error: unknown) => (order.push("A rejected"), error),
    );
    const bTurnEnd = waitForTurnEnd(server, b.sessionId, 60_000).then((event: TurnEndEvent) => {
      order.push("B resolved");
      return event;
    });
    await cli.sendPrompt(b.name, "Reply with exactly: OK");
    const [aOutcome, bStop] = await Promise.all([aTurnEnd, bTurnEnd]);

    expect(bStop.sessionId).toBe(b.sessionId);
    expect(aOutcome).toBeInstanceOf(Error);
    expect((aOutcome as Error).message).toContain(a.sessionId);
    expect(order).toEqual(["B resolved", "A rejected"]);
  });
});
