import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDialogTestIds, controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, onMainFlow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude, type FakeAgentTurn } from "./fake-claude.js";
import { buildAndRun, buildOnCanvas, runIdOf } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";
import { sessionWorktree } from "../src/core/run/workspace.js";

const run = promisify(execFile);
const watchMs = 30_000;

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const rows = <T>(sql: string, ...params: string[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const oneAgent = () => {
  const built = onMainFlow([agent("p1")], []);
  return {
    ...built,
    nodes: built.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
  };
};

const launch = async (options: { turns?: Record<string, FakeAgentTurn>; pieceMs?: number }) => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath(`app-${Date.now()}.log`),
    ...options,
  });
  await expect(launched.window.getByTestId(controlTestIds.build)).toBeVisible();
  return launched.window;
};

const closeApp = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
};

const worktreeOf = (buildId: string) =>
  sessionWorktree(join(home, "workspaces", buildId), "main", repo.path);

const worktreePaths = async (): Promise<string[]> =>
  (await run("git", ["-C", repo.path, "worktree", "list", "--porcelain"])).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const flowdeckBranches = async (): Promise<string[]> =>
  (
    await run("git", [
      "-C",
      repo.path,
      "branch",
      "--list",
      "flowdeck/*",
      "--format=%(refname:short)",
    ])
  ).stdout
    .split("\n")
    .filter((line) => line !== "");

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

type BuildSession = { name: string; buildId: string };

const buildSessions = (pendingId?: string): BuildSession[] =>
  rows<{ body_json: string }>(
    pendingId === undefined
      ? "SELECT body_json FROM build_events"
      : "SELECT body_json FROM build_events WHERE pending_id = ?",
    ...(pendingId === undefined ? [] : [pendingId]),
  )
    .map((row) => JSON.parse(row.body_json) as { type: string } & BuildSession)
    .filter((event) => event.type === "session");

const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const killBuildSessions = async () => {
  if (!existsSync(join(home, "flowdeck.db"))) return;
  for (const { name } of buildSessions()) {
    if (!/^fd-build-/.test(name)) continue;
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
    await rm(join(tmuxSockets, name), { force: true });
  }
};

const deletedAt = (buildId: string) =>
  rows<{ deleted_at: number | null }>("SELECT deleted_at FROM builds WHERE id = ?", buildId)[0]
    ?.deleted_at;

const buildRows = (buildId: string) =>
  rows<{ n: number }>("SELECT count(*) AS n FROM builds WHERE id = ?", buildId)[0]?.n;

const toBuilds = async (window: Page) => {
  await window.getByTestId("menu-builds").click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Builds");
};

const openBlueprint = async (window: Page, flowId: string) => {
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
};

const startBuild = async (window: Page, name: string): Promise<string> => {
  const before = new Set(
    rows<{ id: string }>("SELECT id FROM pending_builds WHERE name = ?", name).map(({ id }) => id),
  );
  await window.getByTestId(controlTestIds.build).click();
  await window.getByTestId(buildDialogTestIds.name).fill(name);
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  const started = () =>
    rows<{ id: string }>("SELECT id FROM pending_builds WHERE name = ?", name)
      .map(({ id }) => id)
      .find((id) => !before.has(id));
  await expect.poll(started).toBeDefined();
  return started() ?? "";
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-bd-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await closeApp();
  } finally {
    await killRunSessions(home);
    await killBuildSessions();
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("A built card has a ⋯ at its top right and no Delete button; the menu closes on Escape and an outside click, and Cancel deletes nothing", async () => {
  seedBlueprint(home, "Alpha", oneAgent(), repo.path);
  const window = await launch({});
  const buildId = await buildOnCanvas(window, home, "keep");
  await toBuilds(window);

  const card = window.getByTestId(pageTestIds.buildCard(buildId));
  const trigger = window.getByTestId(pageTestIds.buildMenu(buildId));
  const del = window.getByTestId(pageTestIds.buildDelete(buildId));
  await expect(card).toBeVisible();
  await expect(trigger).toBeVisible();
  await expect(del).toHaveCount(0);
  const cardBox = await card.boundingBox();
  const triggerBox = await trigger.boundingBox();
  if (cardBox === null || triggerBox === null) throw new Error("the card or its ⋯ has no box");
  expect(triggerBox.x + triggerBox.width).toBeGreaterThan(cardBox.x + cardBox.width * 0.75);
  expect(triggerBox.y).toBeLessThan(cardBox.y + cardBox.height / 2);

  await trigger.click();
  await expect(del).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(del).toHaveCount(0);

  await trigger.click();
  await expect(del).toBeVisible();
  await window.getByTestId(pageTestIds.title).click();
  await expect(del).toHaveCount(0);

  await trigger.click();
  await del.click();
  await expect(window.getByTestId(pageTestIds.deletePrompt)).toBeVisible();
  await window.getByTestId(pageTestIds.deletePromptCancel).click();
  await expect(window.getByTestId(pageTestIds.deletePrompt)).toHaveCount(0);

  await expect(card).toBeVisible();
  expect(deletedAt(buildId)).toBeNull();
  expect(existsSync(worktreeOf(buildId))).toBe(true);
  expect(await flowdeckBranches()).toHaveLength(1);
});

test("While a build's run is going its ⋯ Delete is disabled; after Stop, Delete removes the card and its worktree and keeps the branch whose pull request it could not check", async () => {
  seedBlueprint(home, "Alpha", oneAgent(), repo.path);
  const window = await launch({ turns: { p1: "hold" } });
  const buildId = await buildAndRun(window, home, "busy");
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runStageStatus(runId, "p1"))).toHaveAttribute(
    "data-status",
    "sent",
    { timeout: watchMs },
  );
  const [session] = rows<{ tmux_name: string }>(
    "SELECT tmux_name FROM run_sessions WHERE run_id = ?",
    runId,
  );
  const tmuxName = session?.tmux_name ?? "";
  await expect.poll(() => tmuxAlive(tmuxName)).toBe(true);
  const worktree = worktreeOf(buildId);
  await writeFile(join(worktree, "scratch.txt"), "uncommitted\n");

  await window.getByTestId(pageTestIds.runBack).click();
  await toBuilds(window);
  const card = window.getByTestId(pageTestIds.buildCard(buildId));
  const del = window.getByTestId(pageTestIds.buildDelete(buildId));
  await window.getByTestId(pageTestIds.buildMenu(buildId)).click();
  await expect(del).toBeVisible();
  await expect(del).toBeDisabled();
  await expect(del).toHaveAttribute("aria-disabled", "true");
  await expect(del).toHaveAttribute("title", "Stop or resume its run first");
  await del.click({ force: true });
  await expect(window.getByTestId(pageTestIds.deletePrompt)).toHaveCount(0);
  await expect(card).toBeVisible();
  expect(await tmuxAlive(tmuxName)).toBe(true);
  expect(buildRows(buildId)).toBe(1);

  await window.keyboard.press("Escape");
  await window.getByTestId("menu-runs").click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
  await window.getByTestId(pageTestIds.runStop).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveAttribute(
    "data-status",
    "stopped",
    { timeout: watchMs },
  );
  await expect.poll(() => tmuxAlive(tmuxName), { timeout: watchMs }).toBe(false);

  await window.getByTestId(pageTestIds.runBack).click();
  await toBuilds(window);
  await window.getByTestId(pageTestIds.buildMenu(buildId)).click();
  await expect(del).toBeEnabled();
  await del.click();
  await expect(window.getByTestId(pageTestIds.deletePromptWarning)).toBeVisible();
  await window.getByTestId(pageTestIds.deletePromptConfirm).click();

  await expect(card).toHaveCount(0, { timeout: watchMs });
  await expect(window.getByTestId(pageTestIds.buildKept(buildId))).toContainText(
    "its pull request status could not be checked",
  );
  expect(buildRows(buildId)).toBe(0);
  expect(existsSync(worktree)).toBe(false);
  expect((await worktreePaths()).filter((path) => path.includes(buildId))).toEqual([]);
  expect(await flowdeckBranches()).toHaveLength(1);
});

test("Deleting a building card stops the build, removes its card and workspace, and no older card of that name comes back", async () => {
  test.setTimeout(120_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
  let window = await launch({ pieceMs: 2_500 });
  await openBlueprint(window, flowId);
  const older = await startBuild(window, "fix-a");
  await expect(window.getByTestId(pageTestIds.buildStage(older, 3, 1))).toContainText("running", {
    timeout: watchMs,
  });
  await window.getByTestId(controlTestIds.buildStop).click();
  await expect(window.getByTestId(pageTestIds.buildProgress(older))).toContainText("Stopped", {
    timeout: watchMs,
  });

  await openBlueprint(window, flowId);
  const newer = await startBuild(window, "fix-a");
  await toBuilds(window);
  const card = window.getByTestId(pageTestIds.buildingCard(newer));
  await expect(card).toContainText("Building · step", { timeout: watchMs });
  await expect.poll(() => buildSessions(newer).length, { timeout: watchMs }).toBe(1);
  const [session] = buildSessions(newer);
  const workspace = join(home, "workspaces", session?.buildId ?? "");

  await window.getByTestId(pageTestIds.buildingMenu(newer)).click();
  await window.getByTestId(pageTestIds.buildingDelete(newer)).click();
  await window.getByTestId(pageTestIds.deletePromptConfirm).click();

  await expect(card).toHaveCount(0, { timeout: watchMs });
  await expect(window.getByTestId(pageTestIds.buildingCard(older))).toHaveCount(0);
  await expect.poll(() => tmuxAlive(session?.name ?? ""), { timeout: watchMs }).toBe(false);
  await expect.poll(() => existsSync(workspace), { timeout: watchMs }).toBe(false);
  expect(await flowdeckBranches()).toEqual([]);

  await closeApp();
  window = await launch({ pieceMs: 2_500 });
  await window.getByTestId(controlTestIds.back).click();
  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildingCard(newer))).toHaveCount(0);
  await expect(window.getByTestId(pageTestIds.buildingCard(older))).toHaveCount(0);
});
