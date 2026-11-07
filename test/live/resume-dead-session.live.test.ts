import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../src/adapters/claude/claude-session.js";
import { parseTranscriptTurns } from "../../src/adapters/claude/transcript-turns.js";
import { GitFolderState } from "../../src/adapters/git/git-state.js";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { createAppWaiter } from "../../src/app/engine/app-waiter.js";
import { createEngineHandler, type EngineHandler } from "../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../src/app/engine/protocol.js";
import type { Flow } from "../../src/core/flow/schema.js";
import { nodeStatus } from "../../src/core/run/run-events.js";
import type { PendingWait } from "../../src/core/run/wait.js";
import { FakeConnectorSource } from "../fakes/fake-connector-source.js";
import { flow, gate, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";
import { fakeEngineBuildOptions } from "../fixtures/fake-build-deps.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const deadlineMs = 180_000;
const buildName = "live-resume-dead";
const slugOf = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

async function claudeRunning(sessionId: string): Promise<boolean> {
  try {
    await run("pgrep", ["-f", sessionId]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

async function waitForClaudeToExit(sessionId: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    if (!(await claudeRunning(sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
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

const reply = (id: string, word: string) => ({
  id,
  type: "prompt",
  label: id,
  position: { x: 0, y: 0 },
  settings: { instructions: `Reply with the single word ${word} and nothing else. Use no tools.` },
});

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a run whose Claude session ended", () => {
  const sessionName = `fd-live-revive-${process.pid}`;
  const savedTmux = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  let home: string;
  let repo: TmpRepo;
  let projectFolder: string;
  let handlers: EngineHandler[];
  let closeDb: () => void = () => undefined;

  beforeEach(async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-l-")));
    repo = await createTmpRepo({ commit: true });
    projectFolder = join(homedir(), ".claude", "projects", slugOf(repo.path));
    handlers = [];
  });

  afterEach(async () => {
    try {
      for (const handler of handlers) await handler.stop().catch(() => undefined);
      closeDb();
      await run("tmux", ["-L", sessionName, "kill-server"]).catch(() => undefined);
      const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
      await rm(join(socketFolder, sessionName), { force: true });
      let transcripts: string[] = [];
      try {
        transcripts = (await readdir(projectFolder)).filter((name) => name.endsWith(".jsonl"));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      for (const transcript of transcripts) {
        const sessionId = transcript.replace(/\.jsonl$/, "");
        await waitForClaudeToExit(sessionId);
        await rm(join(projectFolder, transcript));
        await rm(join(projectFolder, sessionId), { recursive: true, force: true });
        for (const folder of ["session-env", "file-history"]) {
          await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
        }
      }
      await removeIfEmpty(join(projectFolder, "memory"));
      await removeIfEmpty(projectFolder);
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedTmux)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  }, 60_000);

  it(
    "goes on in a new tmux session with claude --resume, on the same conversation, sending each node once",
    { timeout: deadlineMs + 60_000 },
    async () => {
      const base = flow(
        [reply("p1", "ALPHA"), gate("g1"), reply("p2", "BRAVO")],
        [thenWire("p1", "g1"), thenWire("g1", "p2")],
      );
      const saved: Flow = {
        ...base,
        session: {
          ...base.session,
          model: "haiku",
          buildConfig: { repo: repo.path, variables: [] },
        },
      };
      const db = openDatabase({ path: join(home, "flowdeck.db") });
      closeDb = () => db.close();
      const stores = { runs: new SqliteStore({ db }), flows: new SqliteFlowStore({ db }) };
      const pushes: EnginePush[] = [];
      const fs = new NodeFileSystem();
      const transcriptOf = (id: string) =>
        new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(id);

      const engine = () => {
        const waiter = createAppWaiter({ push: (push) => pushes.push(push) });
        const handler = createEngineHandler({
          version: "live",
          openStores: () => stores,
          home,
          publish: (push) => pushes.push(push),
          prepareHooks: () => ({
            kind: "ok",
            nodePath: process.execPath,
            hookScriptPath,
            guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
          }),
          ...fakeEngineBuildOptions(fs),
          connectors: new FakeConnectorSource(),
          isFolder: (folder) => statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
          fs,
          run: {
            fs,
            now: Date.now,
            scripts: new NodeProcessRunner(),
            startEvents: async (socketPath) => {
              await mkdir(dirname(socketPath), { recursive: true });
              const server = new HookSocketServer({ socketPath });
              await server.start();
              return { events: server, permissions: server, stop: () => server.stop() };
            },
            openSession: async (options) => {
              const sessions = new TmuxSessionHost({ socketName: options.sessionName });
              return openClaudeSession(options, {
                sessions,
                claude: new ClaudeCli({ sessions }),
                sessionId: options.claudeSessionId,
              });
            },
          },
          waits: waiter,
          sessionAlive: (name) => new TmuxSessionHost({ socketName: name }).has(name),
          worktree: new GitWorktree(),
          gitState: new GitFolderState(),
          newSessionName: () => sessionName,
          transcriptTurns: async (id) => {
            const path = await transcriptOf(id);
            return path === undefined ? [] : parseTranscriptTurns(await readFile(path, "utf8"));
          },
        });
        handlers.push(handler);
        return { handler, waiter };
      };
      const ask = async (handler: EngineHandler, type: string, payload?: unknown) => {
        const response = await handler.handle({
          id: Date.now(),
          type: type as Parameters<EngineHandler["handle"]>[0]["type"],
          payload,
        });
        if (!response.ok) throw new Error(response.error);
        return response.value as never;
      };
      const statusOf = (runId: string, nodeId: string) =>
        nodeStatus(stores.runs.events(runId).filter((event) => event.nodeId === nodeId));
      const sends = (runId: string, nodeId: string) =>
        stores.runs
          .events(runId)
          .filter((event) => event.nodeId === nodeId && event.kind === "sent").length;

      const first = engine();
      const ref = stores.flows.save(saved);
      const started = (await ask(first.handler, "build-version", {
        ...ref,
        name: buildName,
        values: {},
      })) as { kind: string; pendingId: string };
      expect(started.kind).toBe("started");
      await vi.waitFor(
        () => {
          expect(stores.runs.listPendingBuilds().map((open) => open.id)).not.toContain(
            started.pendingId,
          );
        },
        { timeout: 30_000 },
      );
      const record = stores.runs.findBuildByName(buildName);
      if (record === undefined) throw new Error("the build did not finish built");
      const { id: buildId, dir } = record;
      projectFolder = join(
        homedir(),
        ".claude",
        "projects",
        slugOf(join(dir, basename(repo.path))),
      );
      const { runId } = (await ask(first.handler, "run-build", { buildId })) as { runId: string };
      await vi.waitFor(() => expect(statusOf(runId, "g1")).toBe("needs-you"), {
        timeout: deadlineMs,
        interval: 500,
      });
      const claudeSessionId = stores.runs.findRun(runId)?.session.claudeSessionId ?? "";

      await first.handler.detach();
      await run("tmux", ["-L", sessionName, "kill-server"]);
      await waitForClaudeToExit(claudeSessionId);

      const second = engine();
      await second.handler.reattach();
      expect(
        ((await ask(second.handler, "load-run", { runId })) as { run: { status: string } }).run
          .status,
      ).toBe("interrupted");
      pushes.length = 0;
      expect(await ask(second.handler, "resume-run", { runId })).toEqual({
        kind: "started",
        runId,
      });
      const gateWait = () =>
        pushes.findLast((push) => push.push === "wait")?.value as PendingWait | null | undefined;
      await vi.waitFor(() => expect(gateWait()?.request.nodeId).toBe("g1"));
      expect(
        second.waiter.answer({ waitId: gateWait()?.waitId ?? "", reply: { decision: "approve" } }),
      ).toBe(true);
      await vi.waitFor(
        async () =>
          expect(
            await run("tmux", [
              "-L",
              sessionName,
              "list-panes",
              "-a",
              "-F",
              "#{pane_start_command}",
            ])
              .then(({ stdout }) => stdout)
              .catch(() => ""),
          ).toContain(`--resume ${claudeSessionId}`),
        { timeout: 30_000, interval: 200 },
      );

      await vi.waitFor(() => expect(stores.runs.findRun(runId)?.status).not.toBe("running"), {
        timeout: deadlineMs,
        interval: 500,
      });
      expect(stores.runs.findRun(runId)?.status).toBe("done");
      expect([sends(runId, "p1"), sends(runId, "p2")]).toEqual([1, 1]);
      const done = stores.runs
        .events(runId)
        .findLast((event) => event.nodeId === "p2" && event.kind === "done");
      expect(done?.kind === "done" ? done.payload?.stopMessage : undefined).toMatch(/BRAVO/);
      const transcript = await transcriptOf(claudeSessionId);
      if (transcript === undefined) throw new Error("the resumed session wrote no transcript");
      const turns = parseTranscriptTurns(await readFile(transcript, "utf8"));
      expect(turns.map((turn) => turn.userText.includes(`/${buildName}:p2`))).toContain(true);
      expect(turns.map((turn) => turn.userText.includes(`/${buildName}:p1`))).toContain(true);
    },
  );
});
