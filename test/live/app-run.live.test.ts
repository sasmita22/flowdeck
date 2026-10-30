import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn as spawnPty } from "node-pty";
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
import type { EnginePush } from "../../src/app/engine/protocol.js";
import { createTerminal, type PtySpawn, type Terminal } from "../../src/app/main/pty.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";
import type { ActivityEntry } from "../../src/core/run/activity.js";
import { displayStatus, type DisplayStatus } from "../../src/core/run/display.js";
import type { RunEnvironment } from "../../src/core/run/execute.js";
import type { RunSnapshot } from "../../src/core/run/snapshot.js";
import type { TerminalStatus } from "../../src/core/run/terminal.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const fixturePath = fileURLToPath(new URL("../fixtures/run-live-flow.json", import.meta.url));
const askFixturePath = fileURLToPath(new URL("../fixtures/prompt-then-ask.json", import.meta.url));
const runDeadlineMs = 240_000;
const promptIds = ["p1", "p2", "p3"];
const activityFiles = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
const activityPrompt = `Use the Read tool once on each of these five files, one call at a time: ${activityFiles.map((file) => `{{repo}}/${file}`).join(", ")}. Then use the Agent tool once with the prompt "Reply ok". Use no other tools. Then reply DONE.`;

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

function liveEnvironment(fs: NodeFileSystem): RunEnvironment & { now: () => number } {
  return {
    fs,
    now: Date.now,
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
}

async function tmuxOutput(socketName: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("tmux", ["-L", socketName, ...args]);
  return stdout.trim();
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
  let terminal: Terminal | undefined;
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
      await attempt(() => terminal?.dispose());
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
      terminal = undefined;
      handler = undefined;
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(savedTmux)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  }, 60_000);

  async function startFlow(
    path: string,
    publish: (push: EnginePush) => void,
    instructions: Record<string, string> = {},
  ): Promise<void> {
    const fixture = parseFlow(JSON.parse(await readFile(path, "utf8")));
    const flow: Flow = {
      ...fixture,
      nodes: fixture.nodes.map((node) =>
        node.type === "prompt"
          ? {
              ...node,
              settings: {
                instructions: (instructions[node.id] ?? node.settings.instructions).replaceAll(
                  "{{repo}}",
                  repo.path,
                ),
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
    handler = createEngineHandler({
      version: "live",
      openStores: () => stores,
      home,
      publish,
      prepareHooks: () => ({ kind: "ok", nodePath: process.execPath, hookScriptPath }),
      isFolder: (folder) => statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true,
      fs,
      run: liveEnvironment(fs),
      newSessionName: () => sessionName,
    });

    const response = await handler.handle({ id: 1, type: "start-run" });
    expect(response).toMatchObject({ ok: true, value: { kind: "started" } });
  }

  it(
    "publishes waiting, running, done for each prompt, in order, and ends done",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const snapshots: RunSnapshot[] = [];
      await startFlow(fixturePath, (push) => {
        if (push.push === "run-state") snapshots.push(push.value);
      });
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

  it(
    "pushes one activity entry per tool call and subagent of the node that made them, each within 2 s of its hook",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const snapshots: RunSnapshot[] = [];
      const arrivals: { entry: ActivityEntry; receivedAt: number }[] = [];
      for (const file of activityFiles) await writeFile(join(repo.path, file), `${file}\n`);
      await startFlow(
        fixturePath,
        (push) => {
          if (push.push === "activity") {
            arrivals.push({ entry: push.value.entry, receivedAt: Date.now() });
          } else if (push.push === "run-state") snapshots.push(push.value);
        },
        { p2: activityPrompt },
      );
      await vi.waitFor(
        () => {
          expect(snapshots.some((snapshot) => snapshot.status !== "running")).toBe(true);
        },
        { timeout: runDeadlineMs, interval: 500 },
      );

      const latest = [...new Map(arrivals.map(({ entry }) => [entry.id, entry])).values()];
      const of = (nodeId: string) => latest.filter((entry) => entry.nodeId === nodeId);
      const shape = (entry: ActivityEntry) =>
        entry.kind === "tool" ? `tool ${entry.tool}` : `subagent ${entry.state}`;

      expect(of("p2").map(shape).sort()).toEqual([
        "subagent finished",
        "tool Read",
        "tool Read",
        "tool Read",
        "tool Read",
        "tool Read",
      ]);
      expect(of("p1")).toEqual([]);
      const writers = latest.filter((entry) => entry.kind === "tool" && entry.tool === "Write");
      expect(new Set(writers.map((entry) => entry.nodeId))).toEqual(new Set(["p3"]));

      const firstArrival = new Map<number, { entry: ActivityEntry; receivedAt: number }>();
      for (const arrival of arrivals) {
        if (!firstArrival.has(arrival.entry.id)) firstArrival.set(arrival.entry.id, arrival);
      }
      for (const { entry, receivedAt } of firstArrival.values()) {
        expect(receivedAt - entry.at, `delay of entry ${entry.id}`).toBeLessThanOrEqual(2000);
      }
    },
  );

  it(
    "attaches a terminal to the run's own session only on open, and close leaves the run going",
    { timeout: runDeadlineMs + 30_000 },
    async () => {
      const snapshots: RunSnapshot[] = [];
      const statuses: TerminalStatus[] = [];
      const output: string[] = [];
      let spawns = 0;
      const countingSpawn: PtySpawn = (file, args, options) => {
        spawns += 1;
        return spawnPty(file, args, options);
      };
      const live = createTerminal({
        spawn: countingSpawn,
        env: process.env,
        sendStatus: (status) => statuses.push(status),
        sendData: (data) => output.push(data),
      });
      terminal = live;
      let announced = false;
      await startFlow(askFixturePath, (push) => {
        if (push.push === "run-state") snapshots.push(push.value);
        else if (push.push === "session") {
          announced = push.value !== null;
          live.setSession(push.value);
        }
      });

      const tmux = (...args: string[]) => tmuxOutput(sessionName, ...args);
      const target = `=${sessionName}`;
      const clients = async () =>
        (await tmux("list-clients", "-t", target)).split("\n").filter(Boolean);
      const pane = () => tmux("capture-pane", "-p", "-t", `${target}:`);
      const latest = () => snapshots.at(-1);

      await vi.waitFor(
        () => {
          expect(announced).toBe(true);
          expect(displayStatus(latest()?.nodes.p1 ?? "waiting")).toBe("done");
        },
        { timeout: runDeadlineMs, interval: 500 },
      );
      expect(spawns).toBe(0);
      expect(await clients()).toEqual([]);
      expect(live.status()).toEqual({ available: true, attached: false });

      expect(live.open({ cols: 100, rows: 30 })).toBe(true);
      await vi.waitFor(async () => {
        expect(await clients()).toHaveLength(1);
        expect(output.join("")).not.toBe("");
      });

      live.write("fdterm");
      await vi.waitFor(async () => expect(await pane()).toContain("fdterm"), { timeout: 10_000 });

      const clientSize = () =>
        tmux("list-clients", "-t", target, "-F", "#{client_width}x#{client_height}");
      await vi.waitFor(async () => expect(await clientSize()).toBe("100x30"));
      live.resize({ cols: 90, rows: 25 });
      await vi.waitFor(async () => {
        expect(await clientSize()).toBe("90x25");
        expect(await tmux("display", "-p", "-t", `${target}:`, "#{window_width}")).toBe("90");
      });

      expect(live.open({ cols: 100, rows: 30 })).toBe(true);
      expect(spawns).toBe(1);

      live.close();
      await vi.waitFor(async () => expect(await clients()).toEqual([]));
      await expect(tmux("has-session", "-t", target)).resolves.toBe("");
      expect(latest()?.status).toBe("running");

      expect(live.open({ cols: 100, rows: 30 })).toBe(true);
      expect(spawns).toBe(2);
      await vi.waitFor(async () => expect(await clients()).toHaveLength(1));
      expect(await pane()).toContain("fdterm");

      await handler?.stop();
      await vi.waitFor(() =>
        expect(statuses.at(-1)).toEqual({ available: false, attached: false }),
      );
    },
  );
});
