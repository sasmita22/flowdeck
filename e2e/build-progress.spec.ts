import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDialogTestIds, controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { onMainFlow, script } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildOnCanvas } from "./build-run.js";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const run = promisify(execFile);
const pieceMs = 2_500;
const watchMs = 30_000;

const rows = <T>(sql: string, ...params: string[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
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

const worktreePaths = async (): Promise<string[]> =>
  (await run("git", ["-C", repo.path, "worktree", "list", "--porcelain"])).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const buildBranches = async (): Promise<string[]> =>
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

const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const killBuildSessions = async () => {
  if (!existsSync(join(home, "flowdeck.db"))) return;
  for (const { name } of buildSessions()) {
    if (!/^fd-build-/.test(name)) continue;
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
    await rm(join(tmuxSockets, name), { force: true });
  }
};

const startBuild = async (window: Page, name: string): Promise<string> => {
  await window.getByTestId(controlTestIds.build).click();
  await window.getByTestId(buildDialogTestIds.name).fill(name);
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  const pendingOf = () =>
    rows<{ id: string }>("SELECT id FROM pending_builds WHERE name = ?", name)[0]?.id;
  await expect.poll(pendingOf).toBeDefined();
  return pendingOf() ?? "";
};

const oneScript = () =>
  onMainFlow([script("s1", { settings: { command: "sh", args: ["-c", "echo one"] } })], []);

const openBlueprint = async (window: Page, flowId: string) => {
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-bp-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
    await killBuildSessions();
  } finally {
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("a finished build shows Built · v1 on the blueprint's card chip and on its canvas bar", async () => {
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await openBlueprint(window, flowId);

  await buildOnCanvas(window, home, "fix-a");

  await window.getByTestId("menu-blueprints").click();
  await expect(window.getByTestId(pageTestIds.buildChip(flowId))).toHaveText("Built · v1");
  await openBlueprint(window, flowId);
  await expect(window.getByTestId(pageTestIds.canvasBuildBar)).toContainText("Built · v1");
});

test("the canvas bar shows only on a blueprint that has been built", async () => {
  const built = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  const idle = seedBlueprint(home, "Idle", oneScript(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await openBlueprint(window, built.flowId);

  await buildOnCanvas(window, home, "fix-a");

  await openBlueprint(window, built.flowId);
  await expect(window.getByTestId(pageTestIds.canvasBuildBar)).toBeVisible();
  await openBlueprint(window, idle.flowId);
  await expect(window.getByTestId(pageTestIds.canvasBuildBar)).toHaveCount(0);
});

test("while a blueprint builds, its card chip and its canvas bar show the same step, then Built · v1", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  await startBuild(window, "fix-a");

  await window.getByTestId("menu-blueprints").click();
  const chip = window.getByTestId(pageTestIds.buildChip(flowId));
  await expect(chip).toHaveText("Building · step 3 of 5", { timeout: watchMs });
  await openBlueprint(window, flowId);
  const bar = window.getByTestId(pageTestIds.canvasBuildBar);
  await expect(bar).toContainText("Building · step 3 of 5");

  await expect(bar).toContainText("Built · v1", { timeout: watchMs });
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await expect(chip).toHaveText("Built · v1");
});

test("the Builds page shows steps 3 and 4 and each component going waiting, running, done", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  await expect(window.getByTestId(pageTestIds.buildProgress(pendingId))).toBeVisible();
  const step3 = window.getByTestId(pageTestIds.buildStep(pendingId, 3));
  const step4 = window.getByTestId(pageTestIds.buildStep(pendingId, 4));
  const component = window.getByTestId(pageTestIds.buildComponent(pendingId, "script:s1"));
  await expect(step3).toContainText("running", { timeout: watchMs });
  await expect(component).toContainText("waiting");
  await expect(component).toContainText("running", { timeout: watchMs });
  await expect(component).toContainText("done", { timeout: watchMs });
  await expect(step3).toContainText("done", { timeout: watchMs });
  await expect(step4).toContainText("running", { timeout: watchMs });
  await expect(step4).toContainText("done", { timeout: watchMs });
  await expect(window.getByTestId(pageTestIds.buildActivity(pendingId))).toContainText("script:s1");
});

test("the build terminal shows the fd-build session, and Stop ends the build and removes its workspace", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  const progress = window.getByTestId(pageTestIds.buildProgress(pendingId));
  await expect(progress).toBeVisible();
  await expect(window.getByTestId(pageTestIds.buildStep(pendingId, 3))).toContainText("running", {
    timeout: watchMs,
  });
  const [session] = buildSessions(pendingId);
  expect(session?.name).toMatch(/^fd-build-/);
  const name = session?.name ?? "";
  const buildId = session?.buildId ?? "";
  const workspace = join(home, "workspaces", buildId);
  expect(existsSync(workspace)).toBe(true);
  expect((await worktreePaths()).filter((path) => path.includes(buildId))).toHaveLength(1);
  expect(await buildBranches()).toHaveLength(1);

  const terminal = window.getByTestId(pageTestIds.buildTerminal(pendingId));
  await expect(terminal).toBeVisible();
  await terminal.click();
  await expect(progress.getByTestId("terminal-view")).toContainText("fake build session", {
    timeout: watchMs,
  });
  const pane = await run("tmux", ["-L", name, "capture-pane", "-p", "-t", `=${name}:`]);
  expect(pane.stdout).toContain("fake build session");

  await window.getByTestId(controlTestIds.buildStop).click();
  await expect(progress).toContainText("Stopped", { timeout: watchMs });
  await expect.poll(() => existsSync(workspace), { timeout: watchMs }).toBe(false);
  expect((await worktreePaths()).filter((path) => path.includes(buildId))).toEqual([]);
  expect(await buildBranches()).toEqual([]);
  await expect(progress).toBeVisible();
  await window.getByTestId("menu-blueprints").click();
  await expect(window.getByTestId(pageTestIds.buildChip(flowId))).toHaveText("Failed");
});

test("a build that ends with a question shows it under its nodes with an answer field, the chip says Needs you, and Rebuild with answers starts a new build of the blueprint", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    question: { nodeId: "s1", otherNodeId: "s0", text: "Which command runs the tests?" },
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  const progress = window.getByTestId(pageTestIds.buildProgress(pendingId));
  await expect(progress).toContainText("Needs you", { timeout: watchMs });
  const question = window.getByTestId(pageTestIds.buildQuestion(pendingId, 0));
  await expect(question).toContainText("s1 · s0");
  await expect(question).toContainText("Which command runs the tests?");

  const answer = window.getByTestId(pageTestIds.buildAnswer(pendingId, 0));
  const rebuild = window.getByTestId(pageTestIds.buildRebuild(pendingId));
  await expect(answer).toBeVisible();
  await expect(rebuild).toBeDisabled();
  await answer.fill("npm test");
  await expect(rebuild).toBeEnabled();
  await rebuild.click();

  const rebuilt = () =>
    rows<{ version: number; name: string; outcome: string | null; origin_json: string }>(
      "SELECT version, name, outcome, origin_json FROM pending_builds WHERE flow_id = ? AND id != ?",
      flowId,
      pendingId,
    );
  await expect.poll(() => rebuilt().length).toBe(1);
  const [next] = rebuilt();
  expect(next).toMatchObject({ version: 1, name: "fix-a" });
  expect(next?.origin_json).toContain("npm test");
  await expect.poll(() => rebuilt()[0]?.outcome, { timeout: watchMs }).not.toBeNull();
  expect(
    rows<{ outcome: string }>("SELECT outcome FROM pending_builds WHERE id = ?", pendingId),
  ).toEqual([{ outcome: "needs-you" }]);
  await expect(progress).toContainText("Needs you");

  await window.getByTestId("menu-blueprints").click();
  await expect(window.getByTestId(pageTestIds.buildChip(flowId))).toHaveText("Needs you");
});

test("the Builds page shows the build's tokens and cost read from its session's transcript", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneScript(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    usage: {
      userHome: join(home, "user-home"),
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
    },
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  await expect(window.getByTestId(pageTestIds.buildCost(pendingId))).toHaveText(
    "1000000 in · 200000 out · $2.00",
    { timeout: watchMs },
  );
});
