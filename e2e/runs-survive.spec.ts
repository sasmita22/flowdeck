import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { flow, gate, prompt, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const run = promisify(execFile);

let home: string;
let folder: string;
let bin: string;
let launched: LaunchedApp | undefined;

const laidOut = (nodes: unknown[], wires: unknown[]) =>
  flow(
    nodes.map((node, index) => ({
      ...(node as object),
      position: { x: index * 240, y: (index % 2) * 120 },
    })),
    wires,
  );

const sh = (id: string, command: string) =>
  script(id, { settings: { command: "sh", args: ["-c", command] } });

const fakeClaude = `
const { appendFileSync } = require("node:fs");
const { connect } = require("node:net");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + "\\n");
const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? "";
const sock = process.env.FLOWDECK_SOCK ?? "";
const session = sock.slice(sock.lastIndexOf("/") + 1).replace(/\\.sock$/, "");
let typed = "";
const draw = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[HFake Claude in " + session + "\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n",
  );
const stop = () => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "ok" }) + "\\n");
  });
  socket.on("error", () => undefined);
};
process.stdout.on("resize", draw);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") {
      if (typed !== "") setTimeout(stop, 50);
      typed = "";
    } else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const argvLog = () => join(bin, "argv.log");

const launch = async (env: Record<string, string> = {}) => {
  launched = await launchApp({
    home,
    logPath: test.info().outputPath("app.log"),
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      FAKE_CLAUDE_LOG: argvLog(),
      FLOWDECK_CLAUDE_CONFIG: join(home, "claude.json"),
      ...env,
    },
  });
  await expect(launched.window.getByTestId(controlTestIds.run)).toBeVisible();
  return launched.window;
};

const exited = (app: LaunchedApp) =>
  new Promise<void>((resolve) => {
    const proc = app.app.process();
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });

const quit = async () => {
  const current = launched;
  if (current === undefined) return;
  const gone = exited(current);
  await current.app.evaluate(({ app }) => app.quit());
  await gone;
  launched = undefined;
  await current.close();
};

const enginePids = async (app: LaunchedApp) =>
  app.app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .filter(
        (metric) => metric.type === "Utility" && metric.serviceName === "node.mojom.NodeService",
      )
      .map((metric) => metric.pid),
  );

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const rows = <T>(sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const latestRun = () =>
  rows<{ id: string; status: string; tmux_name: string; claude_session_id: string }>(
    `SELECT runs.id, runs.status, run_sessions.tmux_name, run_sessions.claude_session_id
       FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
      ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT 1`,
  )[0];

const sentTwice = (runId: string) =>
  rows<{ node_id: string; n: number }>(
    "SELECT node_id, count(*) AS n FROM events WHERE run_id = ? AND kind = 'sent' GROUP BY node_id HAVING n > 1",
    runId,
  );

const sentCount = (runId: string, nodeId: string) =>
  rows<{ n: number }>(
    "SELECT count(*) AS n FROM events WHERE run_id = ? AND node_id = ? AND kind = 'sent'",
    runId,
    nodeId,
  )[0]?.n;

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const killOwnTmux = async () => {
  let names: { tmux_name: string }[];
  try {
    names = rows("SELECT tmux_name FROM run_sessions");
  } catch {
    return;
  }
  for (const { tmux_name: name } of names) {
    if (!/^fd-run-[0-9a-f]{8}$/.test(name)) continue;
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
    await rm(join(tmuxSockets, name), { force: true });
  }
};

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

const killOwnScripts = async () => {
  const runsDir = join(home, "runs");
  for (const runId of await readdir(runsDir).catch(() => [])) {
    const scriptsDir = join(runsDir, runId, "scripts");
    for (const job of await readdir(scriptsDir).catch(() => [])) {
      if (!job.startsWith("s1-")) continue;
      const pid = Number(await readFile(join(scriptsDir, job, "pid"), "utf8").catch(() => "0"));
      if (pid > 0) killGroup(pid);
    }
  }
};

const status = (window: Page, nodeId: string) => window.getByTestId(`node-status-${nodeId}`);

const openRun = async (window: Page, runId: string) => {
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
};

const atGate = (last: unknown): Flow =>
  laidOut(
    [prompt("p1"), gate("g1", { settings: { shown: "Check the plan", skippable: false } }), last],
    [thenWire("p1", "g1"), thenWire("g1", (last as { id: string }).id)],
  );

const startAtGate = async (input: Flow) => {
  seedFlow(home, input, folder);
  const window = await launch();
  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 30_000 });
  await expect(status(window, "p1")).toHaveAttribute("data-status", "done");
  const started = latestRun();
  if (started === undefined) throw new Error("no run was recorded");
  return started;
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rs-"));
  folder = await realpath(await mkdtemp(join(tmpdir(), "fd-rs-wf-")));
  bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(
    join(home, "claude.json"),
    JSON.stringify({ mcpServers: { jira: { command: "true" } } }),
  );
});

test.afterEach(async () => {
  try {
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    await killOwnTmux();
    await killOwnScripts();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test("Quitting leaves the run and its session going, and a relaunch asks the open question again", async () => {
  const { id: runId, tmux_name: session } = await startAtGate(atGate(sh("s2", "echo two")));
  const [before] = rows<{ id: number }>(
    "SELECT id FROM activity WHERE run_id = ? AND node_id = 'p1' ORDER BY seq LIMIT 1",
    runId,
  );
  if (before === undefined) throw new Error("p1 left no activity before the quit");

  await quit();

  expect(await tmuxAlive(session)).toBe(true);
  expect(latestRun()?.status).toBe("running");
  const window = await launch();
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await expect(window.getByTestId(pageTestIds.runResult(runId))).toHaveText(
    /^(running|needs you)$/,
    { timeout: 20_000 },
  );
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("needs you", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("wait-text").first()).toHaveText("Check the plan");
  await window.getByTestId("run-tab-activity").click();
  await expect(window.getByTestId(`activity-entry-${before.id}`)).toHaveAttribute(
    "data-node-id",
    "p1",
  );
  await window.getByTestId("run-tab-cost").click();
  await expect(window.getByTestId("cost-node-p1")).toBeVisible();
  await window.getByTestId("run-tab-files").click();
  await expect(window.getByTestId("files-empty")).toHaveText("No node has written a file yet");
  await window.getByTestId("run-tab-activity").click();
  await window.getByTestId("wait-approve").first().click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  expect(latestRun()?.status).toBe("done");
  expect(sentCount(runId, "p1")).toBe(1);
  expect(sentTwice(runId)).toEqual([]);
});

test("After a crash the script keeps running, and the relaunched app finishes the run once", async () => {
  seedFlow(
    home,
    laidOut(
      [
        prompt("p1"),
        sh(
          "s1",
          "echo $$ > s1.pid; echo once >> s1.log; n=0; while [ ! -f go ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done",
        ),
        sh("s2", "echo two"),
      ],
      [thenWire("p1", "s1"), thenWire("s1", "s2")],
    ),
    folder,
  );
  const first = await launch();
  await first.getByTestId(controlTestIds.run).click();
  await expect(status(first, "s1")).toHaveAttribute("data-status", "running", { timeout: 30_000 });
  const pidText = () => readFile(join(folder, "s1.pid"), "utf8").catch(() => "");
  await expect.poll(pidText).toMatch(/^\d+\n$/);
  const scriptPid = Number(await pidText());
  const crashed = launched;
  if (crashed === undefined) throw new Error("the app is not running");
  const engines = await enginePids(crashed);
  const gone = exited(crashed);

  const appPid = crashed.app.process().pid;
  if (appPid === undefined) throw new Error("the app has no pid");
  process.kill(appPid, "SIGKILL");
  await gone;
  launched = undefined;
  await crashed.close();

  await expect.poll(() => engines.filter(isRunning), { timeout: 10_000 }).toEqual([]);
  expect(isRunning(scriptPid)).toBe(true);
  const { id: runId } = latestRun() ?? { id: "" };
  const window = await launch();
  await writeFile(join(folder, "go"), "");
  await openRun(window, runId);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  expect(await readFile(join(folder, "s1.log"), "utf8")).toBe("once\n");
  expect(
    rows<{ kind: string }>(
      "SELECT kind FROM events WHERE run_id = ? AND node_id = 's1' ORDER BY seq",
      runId,
    ).map((row) => row.kind),
  ).toEqual(["running", "done"]);
  expect(sentCount(runId, "p1")).toBe(1);
  expect(sentTwice(runId)).toEqual([]);
});

test("A run whose session ended while the app was closed shows interrupted, and Resume starts Claude again with --resume", async () => {
  const input = atGate(prompt("p2"));
  const {
    id: runId,
    tmux_name: session,
    claude_session_id: claudeSessionId,
  } = await startAtGate({ ...input, session: { ...input.session, connectors: ["jira"] } });
  await quit();
  await run("tmux", ["-L", session, "kill-server"]);
  expect(await tmuxAlive(session)).toBe(false);

  const window = await launch();
  await openRun(window, runId);

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("interrupted");
  await expect(window.getByTestId(pageTestIds.runPageNote)).toHaveText(
    "Flowdeck closed while this run was going, and its Claude session has ended since. Resume starts Claude again on the same conversation.",
  );
  await window.getByTestId(pageTestIds.runResume).click();
  await expect(window.getByTestId("wait-text").first()).toHaveText("Check the plan", {
    timeout: 20_000,
  });
  await window.getByTestId("wait-approve").first().click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 30_000,
  });

  const launches = (await readFile(argvLog(), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(launches).toHaveLength(2);
  const [firstLaunch, resumed] = launches;
  expect(firstLaunch).toEqual(expect.arrayContaining(["--session-id", claudeSessionId]));
  expect(firstLaunch).toEqual(
    expect.arrayContaining(["--plugin-dir", "--settings", "--mcp-config"]),
  );
  expect(resumed).toEqual(firstLaunch?.map((arg) => (arg === "--session-id" ? "--resume" : arg)));
  expect(sentCount(runId, "p1")).toBe(1);
  expect(sentCount(runId, "p2")).toBe(1);
});

test("After a relaunch the run's terminal opens on its session", async () => {
  const { id: runId, tmux_name: session } = await startAtGate(atGate(sh("s2", "echo two")));
  await quit();

  const window = await launch();
  await openRun(window, runId);
  await window.getByTestId("run-tab-terminal").click();

  await expect(window.getByTestId("terminal-view")).toContainText(`Fake Claude in ${session}`, {
    timeout: 20_000,
  });
});
