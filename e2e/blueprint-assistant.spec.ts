import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { flow, gate, onMainFlow, prompt, thenWire } from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { latestFlowId, type LaunchedApp } from "../scripts/drive.js";
import { buildAndRun, buildOnCanvas } from "./build-run.js";
import {
  blueprintResults,
  fakeClaudeRan,
  launchWithFakeClaude,
  writeBlueprintAsks,
} from "./fake-claude.js";

const run = promisify(execFile);

const toggleId = "blueprint-terminal-toggle";
const paneId = "blueprint-terminal";

let home: string;
let repo: TmpRepo | undefined;
let launched: LaunchedApp | undefined;

const laidOut = (nodes: unknown[], wires: unknown[]): Flow =>
  flow(
    nodes.map((node, index) => ({
      ...(node as object),
      position: { x: index * 240, y: (index % 2) * 120 },
    })),
    wires,
  );

const runnable = (nodes: unknown[], wires: unknown[]): Flow => {
  const built = onMainFlow(nodes, wires);
  return {
    ...built,
    nodes: built.nodes.map((node, index) => ({
      ...node,
      position: { x: index * 240, y: (index % 2) * 120 },
    })),
  };
};

const bpName = (flowId: string) => `fd-bp-${flowId}`;

const rows = <T>(sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

const capture = async (name: string) =>
  (await run("tmux", ["-L", name, "capture-pane", "-p", "-t", `=${name}:`])).stdout;

const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const killTmux = async (name: string) => {
  await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
  await rm(join(tmuxSockets, name), { force: true });
};

const killOwnTmux = async () => {
  if (!existsSync(join(home, "flowdeck.db"))) return;
  const flowIds = rows<{ id: string }>("SELECT id FROM flows").map(({ id }) => id);
  for (const flowId of flowIds) await killTmux(bpName(flowId));
  const runSessions = (() => {
    try {
      return rows<{ tmux_name: string }>("SELECT tmux_name FROM run_sessions");
    } catch {
      return [];
    }
  })();
  for (const { tmux_name: name } of runSessions) {
    if (/^fd-run-[0-9a-f]{8}$/.test(name)) await killTmux(name);
  }
};

const launches = async () =>
  (await readFile(fakeClaudeRan(home), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[]);

const settingsOf = (argv: string[]) => {
  const at = argv.indexOf("--settings");
  return at === -1 ? "" : (argv[at + 1] ?? "");
};

const bpLaunches = async () =>
  (await launches()).filter((argv) => settingsOf(argv).includes("/bp-sessions/"));

const launch = async () => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    env: { FLOWDECK_CLAUDE_CONFIG: join(home, "claude.json") },
  });
  return launched.window;
};

const openOn = async (window: Page, flowId: string) => {
  const back = window.getByTestId(controlTestIds.back).or(window.getByTestId(pageTestIds.runBack));
  if (await back.isVisible()) await back.click();
  await window.getByTestId("menu-blueprints").click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
};

const seeded = (name: string, nodes: unknown[] = [prompt("p1")], wires: unknown[] = []) =>
  seedBlueprint(home, name, laidOut(nodes, wires)).flowId;

const showPane = async (window: Page, flowId: string) => {
  await window.getByTestId(toggleId).click();
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "true");
  await expect(window.getByTestId(paneId)).toContainText(`Fake Claude in ${bpName(flowId)}`, {
    timeout: 20_000,
  });
};

const askInPane = async (window: Page, text: string) => {
  await window.getByTestId(paneId).locator("textarea.xterm-helper-textarea").focus();
  await window.keyboard.type(text);
  await window.keyboard.press("Enter");
};

const readout = async (window: Page) =>
  JSON.parse((await window.getByTestId("canvas-flow").textContent()) ?? "") as Flow;

const exited = (app: LaunchedApp) =>
  new Promise<void>((resolve) => {
    const proc = app.app.process();
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });

test.beforeEach(async () => {
  launched = undefined;
  repo = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-ba-"));
  await writeFile(join(home, "claude.json"), JSON.stringify({ mcpServers: {} }));
});

test.afterEach(async () => {
  try {
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    await killOwnTmux();
    await rm(home, { recursive: true, force: true });
    await repo?.cleanup();
  }
});

test("showing the agent pane starts an fd-bp session for the open blueprint", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await expect(window.getByTestId(paneId)).toHaveCount(0);

  await showPane(window, flowId);

  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  const started = await bpLaunches();
  expect(started).toHaveLength(1);
  expect(started[0]).toContain("--mcp-config");
  expect(settingsOf(started[0] ?? [])).toContain(`/bp-sessions/${flowId}/`);
});

test("opening a blueprint without the pane starts no session", async () => {
  const flowId = seeded("a");
  const window = await launch();

  await openOn(window, flowId);

  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "false");
  await expect(window.getByTestId(paneId)).toHaveCount(0);
  expect(await bpLaunches()).toEqual([]);
  expect(existsSync(join(home, "bp-sessions"))).toBe(false);
  expect(await tmuxAlive(bpName(flowId))).toBe(false);
});

test("a run's terminal keeps working beside the blueprint terminal", async () => {
  repo = await createTmpRepo({ commit: true });
  const { flowId } = seedFlow(
    home,
    runnable(
      [prompt("p1"), gate("g1", { settings: { shown: "Check the plan", skippable: false } })],
      [thenWire("p1", "g1")],
    ),
    repo.path,
  );
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);

  await buildAndRun(window, home, "beside");
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 30_000 });
  const [started] = rows<{ tmux_name: string }>(
    `SELECT run_sessions.tmux_name FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
      ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT 1`,
  );
  if (started === undefined) throw new Error("no run was recorded");
  const runSession = started.tmux_name;
  await window.getByTestId("run-tab-terminal").click();
  await expect(window.getByTestId("terminal-view")).toContainText(`Fake Claude in ${runSession}`, {
    timeout: 20_000,
  });

  await openOn(window, flowId);
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "true");
  await expect(window.getByTestId(paneId)).toContainText(`Fake Claude in ${bpName(flowId)}`, {
    timeout: 20_000,
  });
  expect(await tmuxAlive(bpName(flowId))).toBe(true);

  await window.getByTestId(paneId).locator("textarea.xterm-helper-textarea").focus();
  await window.keyboard.type("only-in-the-blueprint-pane");

  await expect(window.getByTestId(paneId)).toContainText("only-in-the-blueprint-pane");
  await expect.poll(() => capture(bpName(flowId))).toContain("only-in-the-blueprint-pane");
  expect(await capture(runSession)).not.toContain("only-in-the-blueprint-pane");
});

test("hiding and re-showing the pane keeps one session", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);

  await window.getByTestId(toggleId).click();
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "false");
  await expect(window.getByTestId(paneId)).toHaveCount(0);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  await showPane(window, flowId);

  expect(await bpLaunches()).toHaveLength(1);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
});

test("a never-saved blueprint is saved before its session starts", async () => {
  const window = await launch();
  expect(latestFlowId(home)).toBeUndefined();

  await window.getByTestId(toggleId).click();

  await expect.poll(() => latestFlowId(home)).toBeDefined();
  const flowId = latestFlowId(home) ?? "";
  await expect(window.getByTestId(paneId)).toContainText(`Fake Claude in ${bpName(flowId)}`, {
    timeout: 20_000,
  });
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-blueprints").click();
  await expect(window.getByTestId(pageTestIds.blueprintCard(flowId))).toContainText(/untitled/i);
});

test("agent add_node and wire reach the open canvas unsaved", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);
  await showPane(window, flowId);
  await writeBlueprintAsks(home, [
    [
      {
        name: "add_node",
        input: { type: "script", label: "Tests", settings: { command: "npm", args: ["test"] } },
      },
      { name: "wire", input: thenWire("p1", "script-1") },
      { name: "read_blueprint", input: {} },
    ],
  ]);

  await askInPane(window, "add a script after p1");

  await expect(window.getByTestId(paneId)).toContainText("asks done: 1", { timeout: 20_000 });
  await expect(window.getByTestId("rf__node-script-1")).toBeVisible();
  await expect(window.getByTestId("rf__edge-p1:out->script-1:in")).toBeAttached();
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();
  const results = await blueprintResults(home);
  expect(results.map(({ name }) => name)).toEqual(["add_node", "wire", "read_blueprint"]);
  expect(results[0]?.result).toMatchObject({ ok: true, nodeId: "script-1" });
  expect(results[2]?.result).toMatchObject({
    ok: true,
    unsaved: true,
    flow: {
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "script-1", type: "script", label: "Tests" }),
      ]),
      wires: expect.arrayContaining([thenWire("p1", "script-1")]),
    },
  });
  const saved = rows<{ n: number }>(
    "SELECT count(*) AS n FROM flow_versions WHERE flow_id = ?",
    flowId,
  );
  expect(saved[0]?.n).toBe(1);
});

test("three edits from one ask are undone by one Undo", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);
  const before = await readout(window);
  await writeBlueprintAsks(home, [
    [
      { name: "add_node", input: { type: "script", label: "Lint" } },
      { name: "add_node", input: { type: "script", label: "Tests" } },
      { name: "wire", input: thenWire("p1", "script-1") },
    ],
  ]);

  await askInPane(window, "add two scripts");
  await expect(window.getByTestId(paneId)).toContainText("asks done: 1", { timeout: 20_000 });
  const after = await readout(window);
  expect(after.nodes.map(({ id }) => id)).toEqual(["p1", "script-1", "script-2"]);
  expect(after.wires).toEqual([thenWire("p1", "script-1")]);

  await window.getByTestId(controlTestIds.undo).click();

  await expect.poll(() => readout(window)).toEqual(before);
});

test("opening another blueprint ends the session; leaving the editor does not", async () => {
  const a = seeded("a");
  const b = seeded("b");
  const window = await launch();
  await openOn(window, a);
  await showPane(window, a);

  await window.getByTestId(controlTestIds.back).click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  expect(await tmuxAlive(bpName(a))).toBe(true);

  await openOn(window, b);

  await expect.poll(() => tmuxAlive(bpName(a)), { timeout: 10_000 }).toBe(false);
  await expect(window.getByTestId(paneId)).toHaveCount(0);
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "false");
  expect(await tmuxAlive(bpName(b))).toBe(false);
});

test("quitting ends the blueprint session", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  const current = launched;
  if (current === undefined) throw new Error("the app is not running");

  const gone = exited(current);
  await current.app.evaluate(({ app }) => app.quit());
  await gone;
  launched = undefined;
  await current.close();

  await expect.poll(() => tmuxAlive(bpName(flowId)), { timeout: 10_000 }).toBe(false);
});

test("a leftover fd-bp session is stopped at the next start", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  const crashed = launched;
  if (crashed === undefined) throw new Error("the app is not running");
  const pid = crashed.app.process().pid;
  if (pid === undefined) throw new Error("the app has no pid");

  const gone = exited(crashed);
  process.kill(pid, "SIGKILL");
  await gone;
  launched = undefined;
  await crashed.close();
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  await launch();

  await expect.poll(() => tmuxAlive(bpName(flowId)), { timeout: 20_000 }).toBe(false);
  await expect
    .poll(() => existsSync(join(home, "bp-sessions", flowId)), { timeout: 20_000 })
    .toBe(false);
});

test("reads still reach every blueprint", async () => {
  const a = seeded("a", [prompt("plan-step")]);
  const b = seeded("b", [prompt("review-step")]);
  const window = await launch();
  await openOn(window, a);
  await showPane(window, a);
  const before = await readout(window);
  await writeBlueprintAsks(home, [
    [
      { name: "list_blueprints", input: {} },
      { name: "search_blueprints", input: { query: "review-step" } },
      { name: "read_blueprint", input: { blueprint: b } },
    ],
  ]);

  await askInPane(window, "what does b do");

  await expect(window.getByTestId(paneId)).toContainText("asks done: 1", { timeout: 20_000 });
  const results = await blueprintResults(home);
  expect(results.map(({ name }) => name)).toEqual([
    "list_blueprints",
    "search_blueprints",
    "read_blueprint",
  ]);
  const listed = results[0]?.result as { ok: boolean; blueprints: { flowId: string }[] };
  expect(listed.ok).toBe(true);
  expect(listed.blueprints.map(({ flowId }) => flowId).sort()).toEqual([a, b].sort());
  const found = results[1]?.result as { ok: boolean; blueprints: { flowId: string }[] };
  expect(found.ok).toBe(true);
  expect(found.blueprints.map(({ flowId }) => flowId)).toEqual([b]);
  expect(results[2]?.result).toMatchObject({
    ok: true,
    flow: { nodes: [expect.objectContaining({ id: "review-step" })] },
  });
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("a");
  expect(await readout(window)).toEqual(before);
});

test("an edit aimed at another blueprint is refused", async () => {
  const a = seeded("a", [prompt("plan-step")]);
  const b = seeded("b", [prompt("review-step")]);
  const window = await launch();
  await openOn(window, a);
  await showPane(window, a);
  const before = await readout(window);
  await writeBlueprintAsks(home, [
    [{ name: "add_node", input: { type: "script", label: "Tests", blueprint: b } }],
  ]);

  await askInPane(window, "add a script to b");

  await expect(window.getByTestId(paneId)).toContainText("asks done: 1", { timeout: 20_000 });
  const results = await blueprintResults(home);
  expect(results.map(({ name }) => name)).toEqual(["add_node"]);
  expect(results[0]?.result).toMatchObject({
    isError: true,
    content: [{ type: "text", text: expect.stringContaining("blueprint") }],
  });
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("a");
  expect(await readout(window)).toEqual(before);
  await expect(window.getByTestId(pageTestIds.leaveSave)).toHaveCount(0);
  await expect(window.getByTestId("rf__node-script-1")).toHaveCount(0);
  const saved = rows<{ n: number }>("SELECT count(*) AS n FROM flow_versions WHERE flow_id = ?", b);
  expect(saved[0]?.n).toBe(1);
  expect(await tmuxAlive(bpName(a))).toBe(true);
});

test("the agent lists live, deleted and old builds and reads one", async () => {
  test.setTimeout(120_000);
  repo = await createTmpRepo({ commit: true });
  const repoName = repo.path.split("/").at(-1) ?? "";
  const { flowId } = seedBlueprint(home, "a", runnable([prompt("p1")], []), repo.path);
  const seed = new Database(join(home, "flowdeck.db"));
  try {
    seed
      .prepare("INSERT INTO builds (id, hash, dir, created_at) VALUES (?, ?, ?, ?)")
      .run("oldhash1", "oldhash1", join(home, "builds", "oldhash1"), 1);
  } finally {
    seed.close();
  }
  const window = await launch();
  await openOn(window, flowId);
  const keepId = await buildOnCanvas(window, home, "keep");
  await openOn(window, flowId);
  const goneId = await buildOnCanvas(window, home, "gone");
  await window.getByTestId("menu-builds").click();
  await window.getByTestId(pageTestIds.buildDelete(goneId)).click();
  await expect(window.getByTestId(pageTestIds.buildCard(goneId))).toHaveCount(0);
  expect(
    rows<{ deleted_at: number | null }>("SELECT deleted_at FROM builds WHERE id = ?", goneId)[0]
      ?.deleted_at,
  ).not.toBeNull();
  const [kept] = rows<{ dir: string }>("SELECT dir FROM builds WHERE id = ?", keepId);
  if (kept === undefined) throw new Error("the kept build has no row");
  const worktreePath = join(kept.dir, repoName);
  await writeFile(join(worktreePath, "scratch.txt"), "uncommitted\n");

  await openOn(window, flowId);
  await showPane(window, flowId);
  await writeBlueprintAsks(home, [
    [
      { name: "list_builds", input: {} },
      { name: "read_build", input: { id: keepId } },
    ],
    [{ name: "read_build", input: { id: keepId } }],
  ]);
  await askInPane(window, "what builds are there");
  await expect(window.getByTestId(paneId)).toContainText("asks done: 1", { timeout: 20_000 });

  const first = await blueprintResults(home);
  expect(first.map(({ name }) => name)).toEqual(["list_builds", "read_build"]);
  const listed = first[0]?.result as { ok: boolean; builds: unknown[] };
  expect(listed).toMatchObject({ ok: true });
  expect(listed.builds).toHaveLength(3);
  expect(listed.builds).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: keepId,
        name: "keep",
        blueprint: flowId,
        version: expect.any(Number),
        state: "live",
      }),
      expect.objectContaining({
        id: goneId,
        name: "gone",
        blueprint: flowId,
        version: expect.any(Number),
        state: "deleted",
      }),
      expect.objectContaining({ id: "oldhash1", name: null, state: "old" }),
    ]),
  );
  const read = first[1]?.result as { ok: boolean; workspace: { tree: string[] } };
  expect(read).toMatchObject({
    ok: true,
    repo: repo.path,
    base: "main",
    workspace: { path: kept.dir, exists: true },
    worktree: { path: worktreePath, exists: true, dirty: true, unpushed: false },
  });
  const tree = read.workspace.tree;
  expect(tree).toEqual(expect.arrayContaining(["CLAUDE.md", "settings.json", "manifest.json"]));
  expect(tree.some((path) => path.startsWith("plugin/"))).toBe(true);
  expect(tree.filter((path) => path.startsWith(`${repoName}/`))).toEqual([]);

  await rm(kept.dir, { recursive: true, force: true });
  await askInPane(window, "read it again");
  await expect(window.getByTestId(paneId)).toContainText("asks done: 2", { timeout: 20_000 });

  const second = (await blueprintResults(home)).filter(({ ask }) => ask === 1);
  expect(second.map(({ name }) => name)).toEqual(["read_build"]);
  expect(second[0]?.result).toMatchObject({
    ok: true,
    workspace: { path: kept.dir, exists: false, tree: [] },
    worktree: { path: worktreePath, exists: false, dirty: null, unpushed: null },
  });
});

const sessionCreated = async (name: string) =>
  (
    await run("tmux", ["-L", name, "display", "-p", "-t", `=${name}:`, "#{session_created}"])
  ).stdout.trim();

const boxOf = async (window: Page, selector: string) => {
  const box = await window.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return box;
};

test("the shown pane has a header naming the blueprint, and Minimize keeps its session", async () => {
  const flowId = seeded("Release notes");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);
  const pane = window.getByTestId(paneId);

  await expect(pane.getByRole("heading", { name: "Agent" })).toBeVisible();
  await expect(pane.locator(".fd-blueprint-terminal-name")).toHaveText("Release notes");
  await expect(pane.locator(".fd-blueprint-terminal-state")).toHaveText("running");
  const minimize = pane.getByTestId(controlTestIds.blueprintTerminalMinimize);
  await expect(minimize).toHaveAccessibleName("Minimize");
  await expect(pane.getByTestId(controlTestIds.blueprintTerminalClose)).toHaveAccessibleName(
    "Stop the agent",
  );
  const created = await sessionCreated(bpName(flowId));

  await minimize.click();

  await expect(pane).toHaveCount(0);
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "false");
  await expect(window.getByTestId(pageTestIds.stopAgentDialog)).toHaveCount(0);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  await showPane(window, flowId);
  expect(await sessionCreated(bpName(flowId))).toBe(created);
  expect(await bpLaunches()).toHaveLength(1);
});

test("Close asks first: Cancel keeps the agent, Stop agent ends it and its folder but keeps its edits", async () => {
  const flowId = seeded("a");
  const window = await launch();
  await openOn(window, flowId);
  await showPane(window, flowId);
  const pane = window.getByTestId(paneId);
  await writeBlueprintAsks(home, [
    [{ name: "add_node", input: { type: "script", label: "Tests" } }],
  ]);
  await askInPane(window, "add a script");
  await expect(pane).toContainText("asks done: 1", { timeout: 20_000 });
  await expect(window.getByTestId("rf__node-script-1")).toBeVisible();
  const folder = join(home, "bp-sessions", flowId);
  expect(existsSync(folder)).toBe(true);
  const dialog = window.getByTestId(pageTestIds.stopAgentDialog);

  await pane.getByTestId(controlTestIds.blueprintTerminalClose).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("p")).toHaveText(
    "Stop the agent? Its conversation ends; edits it made stay on the canvas.",
  );
  await expect(dialog.getByRole("button")).toHaveText(["Stop agent", "Cancel"]);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);

  await dialog.getByTestId(pageTestIds.stopAgentCancel).click();
  await expect(dialog).toHaveCount(0);
  await expect(pane).toBeVisible();
  await expect(pane.locator(".fd-blueprint-terminal-state")).toHaveText("running");
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
  expect(existsSync(folder)).toBe(true);

  await pane.getByTestId(controlTestIds.blueprintTerminalClose).click();
  await dialog.getByTestId(pageTestIds.stopAgentConfirm).click();

  await expect(pane).toHaveCount(0);
  await expect(window.getByTestId(toggleId)).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => tmuxAlive(bpName(flowId)), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => existsSync(folder), { timeout: 10_000 }).toBe(false);
  expect((await readout(window)).nodes.map(({ id }) => id)).toEqual(["p1", "script-1"]);
  await expect(window.getByTestId("rf__node-script-1")).toBeVisible();

  await showPane(window, flowId);
  expect(await bpLaunches()).toHaveLength(2);
  expect(await tmuxAlive(bpName(flowId))).toBe(true);
});

test("the pane spans the canvas column, the side panels reach the bottom, and it follows a side panel resize", async () => {
  const flowId = seeded("a");
  const window = await launch();
  const size = { width: 1280, height: 800 };
  await launched?.app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(next.width, next.height);
  }, size);
  await window.waitForFunction(
    (next) => globalThis.innerWidth === next.width && globalThis.innerHeight === next.height,
    size,
  );
  await openOn(window, flowId);
  await window.getByTestId(controlTestIds.inspectorShow).click();
  await expect(window.getByTestId("inspector")).toBeVisible();
  await showPane(window, flowId);

  const layout = async () => {
    const pane = await boxOf(window, `[data-testid="${paneId}"]`);
    const canvas = await boxOf(window, ".fd-canvas");
    const sidebar = await boxOf(window, "aside[aria-label='Nodes']");
    const inspector = await boxOf(window, ".fd-inspector");
    const status = await boxOf(window, ".fd-status-bar");
    return {
      paneLeft: pane.x - canvas.x,
      paneRight: pane.x + pane.width - (canvas.x + canvas.width),
      paneBelowCanvas: pane.y - (canvas.y + canvas.height),
      paneBottom: pane.y + pane.height - status.y,
      sidebarBottom: sidebar.y + sidebar.height - status.y,
      inspectorBottom: inspector.y + inspector.height - status.y,
      paneWidth: pane.width,
    };
  };
  const flush = {
    paneLeft: 0,
    paneRight: 0,
    paneBelowCanvas: 0,
    paneBottom: 0,
    sidebarBottom: 0,
    inspectorBottom: 0,
  };
  const before = await layout();
  expect(before).toEqual({ ...flush, paneWidth: before.paneWidth });

  const handle = await boxOf(window, `[data-testid="${controlTestIds.inspectorResize}"]`);
  await window.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await window.mouse.down();
  await window.mouse.move(handle.x + handle.width / 2 - 100, handle.y + handle.height / 2, {
    steps: 10,
  });
  await window.mouse.up();

  await expect.poll(layout).toEqual({ ...flush, paneWidth: before.paneWidth - 100 });
});
