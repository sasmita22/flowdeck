import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TranscriptUsage } from "../../src/adapters/claude/transcript-usage.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { workspaceClaudeMd } from "../../src/core/compiler/emit.js";
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

type Session = { name: string; sessionId: string };

type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: { to?: string };
  tool_use_id?: string;
  content?: unknown;
};

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a message between connected sessions", () => {
  useTempClaudeConfig();
  const iosVariable = sessionEnvNames([{ kind: "session", slug: "ios" }]).get("ios")?.tmux ?? "";
  let sessions: Session[] = [];
  let repo: TmpRepo | undefined;
  let workspace: string | undefined;

  afterEach(async () => {
    for (const session of sessions) await killTmuxServer(session.name);
    if (repo !== undefined) {
      await removeClaudeSessions(
        repo.path,
        sessions.map(({ sessionId }) => sessionId),
      );
      await repo.cleanup();
    }
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
    sessions = [];
    repo = undefined;
    workspace = undefined;
  }, 60_000);

  const pair = (label: string) => {
    const session = (slug: string) => ({
      name: `fd-live-msg-${label}-${slug}-${process.pid}`,
      sessionId: randomUUID(),
    });
    const android = session("android");
    const ios = session("ios");
    sessions.push(android, ios);
    return { android, ios };
  };

  const start = async (
    session: Session,
    cwd: string,
    env: Record<string, string>,
    named = true,
  ) => {
    const cli = new ClaudeCli({ sessions: new TmuxSessionHost({ socketName: session.name }) });
    await cli.start(
      session.name,
      cwd,
      { sessionId: session.sessionId, ...(named ? { name: session.name } : {}), model },
      { env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ...env } },
    );
    await cli.waitUntilReady(session.name);
    return cli;
  };

  const entriesOf = async (sessionId: string): Promise<TranscriptEntry[]> => {
    const path = await findClaudeTranscript(sessionId);
    return path === undefined ? [] : readLines<TranscriptEntry>(path);
  };

  const blocksOf = (entries: readonly TranscriptEntry[]) =>
    entries.flatMap(({ message }) =>
      Array.isArray(message?.content) ? (message.content as Block[]) : [],
    );

  const received = (entries: readonly TranscriptEntry[], token: string) =>
    entries.some((entry) => {
      const text = JSON.stringify(entry);
      return text.includes("cross-session-message") && text.includes(token);
    });

  const sendsIn = (entries: readonly TranscriptEntry[]) => {
    const blocks = blocksOf(entries);
    return blocks
      .filter((block) => block.type === "tool_use" && block.name === "SendMessage")
      .map((send) => ({
        to: send.input?.to,
        succeeded: blocks.some(
          (block) =>
            block.type === "tool_result" &&
            block.tool_use_id === send.id &&
            JSON.stringify(block.content).includes('\\"success\\":true'),
        ),
      }));
  };

  const turnEnded = (entries: readonly TranscriptEntry[]) =>
    entries
      .map(({ message }) => message as { role?: string; stop_reason?: string } | undefined)
      .filter((message) => message?.role === "assistant")
      .at(-1)?.stop_reason === "end_turn";

  const reportCost = async (
    label: string,
    { android, ios }: { android: Session; ios: Session },
  ) => {
    const usage = new TranscriptUsage({ findTranscript: findClaudeTranscript });
    const androidCost = costOf(await usage.entries(android.sessionId));
    const iosCost = costOf(await usage.entries(ios.sessionId));
    process.stderr.write(
      `${label} cost: android ${usd(androidCost)}, ios ${usd(iosCost)}, total ${usd(androidCost + iosCost)}\n`,
    );
  };

  it("reaches the session named in the peer variable", { timeout: 600_000 }, async () => {
    expect(iosVariable).toBe("FD_SESSION_IOS_TMUX");
    const { android, ios } = pair("named");
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
      expect(sendsIn(await entriesOf(android.sessionId))).toContainEqual({
        to: ios.name,
        succeeded: true,
      });
    } finally {
      await reportCost("named", { android, ios });
    }
  });

  it(
    "sends to no other session when the named one cannot be reached",
    { timeout: 600_000 },
    async () => {
      const { android, ios } = pair("unnamed");
      repo = await createTmpRepo({ commit: true });
      workspace = await mkdtemp(join(tmpdir(), "fd-live-msg-ws-"));
      await writeFile(
        join(repo.path, "CLAUDE.md"),
        workspaceClaudeMd(
          { name: "msg-android", values: {} },
          { repo: repo.path, base: "main", branch: "main", branchCreated: false, workspace },
          [{ name: "ios", slug: "ios", tmux: iosVariable }],
        ),
      );
      const token = `fd-msg-${randomUUID().slice(0, 8)}`;
      await start(ios, repo.path, {}, false);
      const sender = await start(android, repo.path, { [iosVariable]: ios.name });

      await sender.sendPrompt(
        android.name,
        `Send ${token} with SendMessage to the session named in $${iosVariable}.`,
      );

      try {
        await vi.waitFor(
          async () => {
            const entries = await entriesOf(android.sessionId);
            expect(sendsIn(entries).some(({ to }) => to === ios.name)).toBe(true);
            expect(turnEnded(entries)).toBe(true);
          },
          { timeout: 180_000, interval: 2000 },
        );
        const sends = sendsIn(await entriesOf(android.sessionId));
        expect(sends.filter(({ to }) => to === ios.name)).not.toContainEqual({
          to: ios.name,
          succeeded: true,
        });
        expect(sends.filter(({ to }) => to !== ios.name)).toEqual([]);
        expect(received(await entriesOf(ios.sessionId), token)).toBe(false);
      } finally {
        await reportCost("unnamed", { android, ios });
      }
    },
  );
});
