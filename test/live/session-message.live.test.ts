import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TranscriptUsage } from "../../src/adapters/claude/transcript-usage.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { sessionEnvNames } from "../../src/core/compiler/hook-settings.js";
import { costOf, usd } from "../../src/core/run/budget.js";
import { findClaudeTranscript, useTempClaudeConfig } from "../fixtures/claude-config.js";
import { paneText } from "../fixtures/live-evidence.js";
import {
  killTmuxServer,
  readLines,
  removeClaudeSessions,
  type TranscriptEntry,
} from "../fixtures/live-claude.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const model = "haiku";

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a message between connected sessions", () => {
  useTempClaudeConfig();
  const android = { name: `fd-live-msg-android-${process.pid}`, sessionId: randomUUID() };
  const ios = { name: `fd-live-msg-ios-${process.pid}`, sessionId: randomUUID() };
  const iosVariable = sessionEnvNames([{ kind: "session", slug: "ios" }]).get("ios")?.tmux ?? "";
  let repo: TmpRepo | undefined;

  afterEach(async () => {
    await killTmuxServer(android.name);
    await killTmuxServer(ios.name);
    if (repo !== undefined) {
      await removeClaudeSessions(repo.path, [android.sessionId, ios.sessionId]);
      await repo.cleanup();
    }
  }, 60_000);

  const start = async (
    session: { name: string; sessionId: string },
    cwd: string,
    env: Record<string, string>,
  ) => {
    const cli = new ClaudeCli({ sessions: new TmuxSessionHost({ socketName: session.name }) });
    await cli.start(
      session.name,
      cwd,
      { sessionId: session.sessionId, name: session.name, model },
      { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ...env } },
    );
    await cli.waitUntilReady(session.name);
    return cli;
  };

  type Block = {
    type?: string;
    id?: string;
    name?: string;
    input?: { to?: string };
    tool_use_id?: string;
    content?: unknown;
  };

  const entriesOf = async (sessionId: string): Promise<TranscriptEntry[]> => {
    const path = await findClaudeTranscript(sessionId);
    return path === undefined ? [] : readLines<TranscriptEntry>(path);
  };

  const received = (entries: readonly TranscriptEntry[], token: string) =>
    entries.some((entry) => {
      const text = JSON.stringify(entry);
      return text.includes("cross-session-message") && text.includes(token);
    });

  const deliveredTo = (entries: readonly TranscriptEntry[], recipient: string) => {
    const blocks = entries.flatMap(({ message }) =>
      Array.isArray(message?.content) ? (message.content as Block[]) : [],
    );
    const sends = blocks.filter(
      (block) =>
        block.type === "tool_use" && block.name === "SendMessage" && block.input?.to === recipient,
    );
    return blocks.some(
      (block) =>
        block.type === "tool_result" &&
        sends.some((send) => send.id === block.tool_use_id) &&
        JSON.stringify(block.content).includes('\\"success\\":true'),
    );
  };

  const costOfSession = async (sessionId: string) =>
    costOf(await new TranscriptUsage({ findTranscript: findClaudeTranscript }).entries(sessionId));

  it("reaches the session named in the peer variable", { timeout: 600_000 }, async () => {
    expect(iosVariable).toBe("FD_SESSION_IOS_TMUX");
    repo = await createTmpRepo({ commit: true });
    const token = `fd-msg-${randomUUID().slice(0, 8)}`;
    await start(ios, repo.path, {});
    const sender = await start(android, repo.path, { [iosVariable]: ios.name });

    await sender.sendPrompt(
      android.name,
      `Send ${token} with SendMessage to the session named in $${iosVariable}.`,
    );

    try {
      await vi.waitFor(
        async () => {
          expect(received(await entriesOf(ios.sessionId), token)).toBe(true);
        },
        { timeout: 180_000, interval: 2000 },
      );
      expect(await paneText(ios.name, ios.name)).toContain(token);
      expect(deliveredTo(await entriesOf(android.sessionId), ios.name)).toBe(true);
    } finally {
      const androidCost = await costOfSession(android.sessionId);
      const iosCost = await costOfSession(ios.sessionId);
      process.stderr.write(
        `session message cost: android ${usd(androidCost)}, ios ${usd(iosCost)}, total ${usd(androidCost + iosCost)}\n`,
      );
    }
  });
});
