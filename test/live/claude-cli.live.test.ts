import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, rmdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli, replyLine } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);

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

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("ClaudeCli with real claude", () => {
  const socketName = `fd-live-${process.pid}`;
  let sessions: TmuxSessionHost;
  let cli: ClaudeCli;
  let repo: TmpRepo;
  let sessionId: string;
  let name: string;

  async function startClaude(label: string): Promise<void> {
    name = `fd-live-${process.pid}-${label}`;
    await cli.start(name, repo.path, { sessionId, model: "haiku" });
    await cli.waitUntilReady(name);
  }

  afterAll(async () => {
    const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    await rm(join(socketFolder, socketName), { force: true });
  });

  beforeEach(async () => {
    sessions = new TmuxSessionHost({ socketName });
    cli = new ClaudeCli({ sessions });
    repo = await createTmpRepo();
    sessionId = randomUUID();
  });

  afterEach(async () => {
    if (name && (await sessions.has(name))) await sessions.stop(name);
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
    await repo.cleanup();
  });

  it(
    "replies with the requested token and writes a transcript named after the session id",
    { timeout: 120_000 },
    async () => {
      await startClaude("pong");

      await cli.sendPrompt(name, "Reply with exactly: FD-PONG");
      await cli.waitForReply(name, replyLine("FD-PONG"), 60_000);

      expect(await cli.findTranscript(sessionId)).toBeDefined();
    },
  );

  it("the reply check fails for a different token", { timeout: 120_000 }, async () => {
    await startClaude("ping");

    await cli.sendPrompt(name, "Reply with exactly: FD-PING");
    const pane = await cli.waitForReply(name, replyLine("FD-PING"), 60_000);

    expect(replyLine("FD-PONG").test(pane)).toBe(false);
  });
});
