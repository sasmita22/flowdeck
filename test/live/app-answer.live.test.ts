import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../src/adapters/claude/claude-session.js";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { createAppWaiter } from "../../src/app/engine/app-waiter.js";
import { createEngineHandler } from "../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../src/app/engine/protocol.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { RunEnvironment } from "../../src/core/run/execute.js";
import type { StoredEvent } from "../../src/core/run/store.js";
import type { PendingWait } from "../../src/core/run/wait.js";
import { ask, flow, prompt, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const runDeadlineMs = 180_000;

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

async function transcriptsIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function tmuxServerAlive(socketName: string): Promise<boolean> {
  try {
    await run("tmux", ["-L", socketName, "list-sessions"]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

function liveEnvironment(
  fs: NodeFileSystem,
  waiter: RunEnvironment["waiter"],
): RunEnvironment & { now: () => number } {
  return {
    fs,
    now: Date.now,
    scripts: new NodeProcessRunner(),
    waiter,
    startEvents: async (socketPath) => {
      await mkdir(dirname(socketPath), { recursive: true });
      const server = new HookSocketServer({ socketPath });
      await server.start();
      return { events: server, stop: () => server.stop() };
    },
    openSession: async (options) => {
      const sessions = new TmuxSessionHost({ socketName: options.sessionName });
      return openClaudeSession(options, {
        sessions,
        claude: new ClaudeCli({ sessions }),
        sessionId: options.claudeSessionId,
      });
    },
  };
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("answering an ask from the app", () => {
  const sessionName = `fd-la-${process.pid}`;
  const savedTmux = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  let home: string;
  let repo: TmpRepo;
  let projectFolder: string;
  let handler: ReturnType<typeof createEngineHandler> | undefined;
  let closeDb: () => void = () => undefined;

  beforeEach(async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    home = await mkdtemp(join(tmpdir(), "fd-l-"));
    repo = await createTmpRepo();
    projectFolder = join(homedir(), ".claude", "projects", repo.path.replace(/[^a-zA-Z0-9]/g, "-"));
  });

  afterEach(async () => {
    let failure: { error: unknown } | undefined;
    const attempt = async (step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        failure ??= { error };
      }
    };
    try {
      await attempt(() => handler?.stop());
      await attempt(closeDb);
      const alive = await tmuxServerAlive(sessionName);
      if (alive) await run("tmux", ["-L", sessionName, "kill-server"]);
      const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
      await rm(join(socketFolder, sessionName), { force: true });
      for (const transcript of await transcriptsIn(projectFolder)) {
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
      if (failure) throw failure.error;
      expect(alive, `the run's tmux server ${sessionName} was still up after stop()`).toBe(false);
    } finally {
      handler = undefined;
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedTmux)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  }, 60_000);

  it(
    "carries the answer blue into the next Claude turn",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const built = flow(
        [
          ask("q"),
          prompt("p", {
            settings: { instructions: "Reply with the colour the user answered, one word." },
          }),
        ],
        [thenWire("q", "p")],
      );
      const saved: Flow = {
        ...built,
        session: {
          ...built.session,
          model: "haiku",
          workingFolder: { kind: "path", path: repo.path },
        },
      };

      const db = openDatabase({ path: join(home, "flowdeck.db") });
      closeDb = () => db.close();
      const stores = { runs: new SqliteStore({ db }), flows: new SqliteFlowStore({ db }) };
      stores.flows.save(saved);

      const waits: (PendingWait | null)[] = [];
      let runId = "";
      let answered: Promise<unknown> | undefined;
      const publish = (push: EnginePush) => {
        if (push.push === "wait") {
          waits.push(push.value);
          if (push.value?.request.nodeId === "q" && answered === undefined) {
            answered = handler?.handle({
              id: 2,
              type: "answer-wait",
              payload: {
                waitId: push.value.waitId,
                reply: { decision: "answer", answer: "blue" },
              },
            });
          }
        }
        if (push.push === "run-state") runId = push.value.runId;
      };
      const appWaiter = createAppWaiter({ push: (message) => publish(message) });

      const fs = new NodeFileSystem();
      handler = createEngineHandler({
        version: "live",
        openStores: () => stores,
        home,
        publish,
        prepareHooks: () => ({ kind: "ok", nodePath: process.execPath, hookScriptPath }),
        isFolder: (folder) => statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
        fs,
        run: liveEnvironment(fs, appWaiter),
        worktree: new GitWorktree(),
        waits: appWaiter,
        newSessionName: () => sessionName,
      });

      const response = await handler.handle({ id: 1, type: "start-run" });
      expect(response).toMatchObject({ ok: true, value: { kind: "started" } });

      await vi.waitFor(() => expect(answered).toBeDefined(), { timeout: 30_000, interval: 200 });
      expect(await answered).toMatchObject({ ok: true, value: { accepted: true } });

      await vi.waitFor(
        () => {
          expect(stores.runs.findRun(runId)?.status).not.toBe("running");
        },
        { timeout: runDeadlineMs, interval: 500 },
      );

      const events = stores.runs.events(runId);
      expect(events).toContainEqual(
        expect.objectContaining({
          nodeId: "q",
          kind: "answered",
          payload: { nodeId: "q", decision: "answered", answer: "blue" },
        }),
      );
      const done = events.find(
        (event): event is Extract<StoredEvent, { kind: "done" }> =>
          event.nodeId === "p" && event.kind === "done",
      );
      expect(done?.payload).toEqual({ stopMessage: expect.stringMatching(/blue/i) });
      expect(stores.runs.findRun(runId)?.status).toBe("done");
      expect(waits.at(-1)).toBeNull();
    },
  );
});
