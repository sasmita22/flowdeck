import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openClaudeSession } from "../../src/adapters/claude/claude-session.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { SqliteFlowStore } from "../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { createEngineHandler } from "../../src/app/engine/engine-handler.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";
import { displayStatus, type DisplayStatus } from "../../src/core/run/display.js";
import type { RunEnvironment } from "../../src/core/run/execute.js";
import type { RunSnapshot } from "../../src/core/run/snapshot.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("../fixtures/run-live-flow.json", import.meta.url));
const runDeadlineMs = 240_000;
const promptIds = ["p1", "p2", "p3"];

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

const withoutRepeats = (values: readonly DisplayStatus[]) =>
  values.filter((value, index) => index === 0 || values[index - 1] !== value);

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("the app engine running a saved flow", () => {
  const sessionName = `fd-live-app-${process.pid}`;
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
    try {
      await handler?.stop();
      closeDb();
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
      expect(alive, `the run's tmux server ${sessionName} was still up after stop()`).toBe(false);
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedTmux)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  }, 60_000);

  it(
    "publishes waiting, running, done for each prompt, in order, and ends done",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const fixture = parseFlow(JSON.parse(await readFile(fixturePath, "utf8")));
      const flow: Flow = {
        ...fixture,
        nodes: fixture.nodes.map((node) =>
          node.type === "prompt"
            ? {
                ...node,
                settings: {
                  instructions: node.settings.instructions.replaceAll("{{repo}}", repo.path),
                },
              }
            : node,
        ),
        session: { ...fixture.session, workingFolder: { kind: "path", path: repo.path } },
      };

      const db = openDatabase({ path: join(home, "flowdeck.db") });
      closeDb = () => db.close();
      const stores = { runs: new SqliteStore({ db }), flows: new SqliteFlowStore({ db }) };
      stores.flows.save(flow);

      const fs = new NodeFileSystem();
      const environment: RunEnvironment = {
        fs,
        scripts: new NodeProcessRunner(),
        waiter: { wait: () => new Promise(() => undefined) },
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
      const snapshots: RunSnapshot[] = [];
      handler = createEngineHandler({
        version: "live",
        openStores: () => stores,
        home,
        publish: (push) => snapshots.push(push.value),
        prepareHooks: () => ({ kind: "ok", nodePath: process.execPath, hookScriptPath }),
        isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
        fs,
        run: environment,
        newSessionName: () => sessionName,
      });

      const response = await handler.handle({ id: 1, type: "start-run" });
      expect(response).toMatchObject({ ok: true, value: { kind: "started" } });
      await vi.waitFor(
        () => {
          expect(snapshots.some((snapshot) => snapshot.status !== "running")).toBe(true);
        },
        { timeout: runDeadlineMs, interval: 500 },
      );

      const shown = (id: string) =>
        snapshots.map((snapshot) => displayStatus(snapshot.nodes[id] ?? "waiting"));
      for (const id of promptIds) {
        expect(withoutRepeats(shown(id)), `display statuses of ${id}`).toEqual([
          "waiting",
          "running",
          "done",
        ]);
      }
      const first = (id: string, status: DisplayStatus) => shown(id).indexOf(status);
      expect(first("p2", "running")).toBeGreaterThan(first("p1", "done"));
      expect(first("p3", "running")).toBeGreaterThan(first("p2", "done"));
      expect(snapshots.at(-1)?.status).toBe("done");
    },
  );
});
