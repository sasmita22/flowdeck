import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import type { HumanWaiter, WaitRequest } from "../../src/core/run/wait.js";
import { sessionWorktree, workspaceFolder } from "../../src/core/run/workspace.js";
import { findClaudeTranscript, useTempClaudeConfig } from "../fixtures/claude-config.js";
import { sessionsWorkflow } from "../fixtures/flow-builders.js";
import {
  killTmuxServer,
  readLines,
  removeClaudeSessions,
  type TranscriptEntry,
} from "../fixtures/live-claude.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const model = "haiku";
const note = "hi";

type ToolBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: { file_path?: string };
  is_error?: boolean;
};

const blocksOf = (entries: TranscriptEntry[]): ToolBlock[] =>
  entries.flatMap(({ message }) =>
    Array.isArray(message?.content) ? (message.content as ToolBlock[]) : [],
  );

async function entriesOf(sessionId: string): Promise<TranscriptEntry[]> {
  const path = await findClaudeTranscript(sessionId);
  if (path === undefined) return [];
  const subagents = join(path.replace(/\.jsonl$/, ""), "subagents");
  const names = await readdir(subagents).catch(() => []);
  const files = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(subagents, name));
  return (
    await Promise.all([path, ...files].map((file) => readLines<TranscriptEntry>(file)))
  ).flat();
}

function refusedWrites(entries: TranscriptEntry[], target: string): ToolBlock[] {
  const blocks = blocksOf(entries);
  const attempts = blocks.filter(
    (block) =>
      block.type === "tool_use" &&
      (block.name === "Edit" || block.name === "Write") &&
      block.input?.file_path?.endsWith(target) === true,
  );
  return attempts.filter((attempt) =>
    blocks.some(
      (block) =>
        block.type === "tool_result" && block.tool_use_id === attempt.id && block.is_error === true,
    ),
  );
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a session container and the workspace", () => {
  useTempClaudeConfig();
  const sessionName = `fd-live-ws-${process.pid}`;
  const writerName = `fd-live-ws-writer-${process.pid}`;
  const writerId = randomUUID();
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let writerCwd: string | undefined;
  let readerCwd: string | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    writerCwd = undefined;
    readerCwd = undefined;
  });

  afterEach(async () => {
    await killTmuxServer(writerName);
    if (writerCwd !== undefined) await removeClaudeSessions(writerCwd, [writerId]);
    if (readerCwd !== undefined) {
      await removeClaudeSessions(readerCwd, engine?.sessionIds ?? []);
    }
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "reads the note the workspace session wrote with no question, and is refused when it edits it",
    { timeout: 600_000 },
    async () => {
      const questions: WaitRequest[] = [];
      const waiter: HumanWaiter = {
        wait: async (request) => {
          questions.push(request);
          return { decision: "reject", reason: "no questions in this check" };
        },
      };
      engine = liveEngine({ home, repo: repo.path, sessionName, waiter });
      const flow = sessionsWorkflow([
        { name: "app", repo: repo.path, branch: "main", model, members: ["Copy"] },
      ]);
      const copy = flow.nodes.find((node) => node.id === "session-1-copy");
      if (copy?.type !== "agent") throw new Error("no Copy agent");
      const instructed = {
        ...flow,
        settings: { ...flow.settings, buildModel: model, permissionMode: "acceptEdits" },
        nodes: flow.nodes.map((node) =>
          node === copy
            ? {
                ...copy,
                settings: {
                  ...copy.settings,
                  model,
                  instructions:
                    "Copy ../../../workspace/note.md to copy.md. Then append x to ../../../workspace/note.md.",
                },
              }
            : node,
        ),
      };
      const built = await engine.saveAndBuild(instructed, { name: "live-ws" });
      const workspace = workspaceFolder(built.dir);
      const notePath = join(workspace, "note.md");
      writerCwd = workspace;
      readerCwd = sessionWorktree(built.dir, "app", repo.path);

      const writer = new ClaudeCli({ sessions: new TmuxSessionHost({ socketName: writerName }) });
      await writer.start(
        writerName,
        workspace,
        { sessionId: writerId, model },
        { settingsPath: "settings.json", pluginDirs: ["plugin"] },
      );
      await writer.waitUntilReady(writerName);
      await writer.sendPrompt(writerName, `Write ${note} to note.md.`);
      await vi.waitFor(async () => expect((await readFile(notePath, "utf8")).trim()).toBe(note), {
        timeout: 120_000,
        interval: 1000,
      });

      const runId = await engine.runBuild(built.buildId, { auto: true });
      const status = await engine.waitForRunEnd(runId, 360_000);
      const copied = join(readerCwd, "copy.md");
      const entries = (
        await Promise.all(engine.sessionIds.map((sessionId) => entriesOf(sessionId)))
      ).flat();

      expect(status).toBe("done");
      expect(questions).toEqual([]);
      expect(existsSync(copied) ? (await readFile(copied, "utf8")).trim() : null).toBe(note);
      expect((await readFile(notePath, "utf8")).trim()).toBe(note);
      expect(refusedWrites(entries, "workspace/note.md").length).toBeGreaterThan(0);
    },
  );
});
