import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDialogTestIds, controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, onMainFlow, thenWire } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";

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

const spread = (flow: ReturnType<typeof onMainFlow>) => ({
  ...flow,
  nodes: flow.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
});

const oneAgent = () => spread(onMainFlow([agent("s1")], []));

const twoAgents = () => spread(onMainFlow([agent("s1"), agent("s2")], [thenWire("s1", "s2")]));

const openBlueprint = async (window: Page, flowId: string) => {
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
};

const toBuilds = async (window: Page) => {
  await window.getByTestId("menu-builds").click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Builds");
};

const builtIdNamed = (name: string) =>
  rows<{ id: string }>("SELECT id FROM builds WHERE name = ?", name)[0]?.id;

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

test("a build in progress shows a Building card on Builds and a live marker on the Builds menu item, opens its pipeline, then becomes a built card and the marker goes", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  await toBuilds(window);
  const card = window.getByTestId(pageTestIds.buildingCard(pendingId));
  await expect(card).toContainText("Building · step 3 of 5", { timeout: watchMs });
  await expect(card).toContainText("fix-a");
  await expect(window.getByTestId(controlTestIds.menuBuildsLive)).toBeVisible();
  await expect(window.getByTestId("menu-builds")).toContainText(", 1 building");

  await card.click();
  await expect(window.getByTestId(pageTestIds.buildProgress(pendingId))).toBeVisible();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("fix-a");
  await expect(window.getByTestId(pageTestIds.buildBuiltLink(pendingId))).toBeVisible({
    timeout: watchMs,
  });

  const buildId = builtIdNamed("fix-a") ?? "";
  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildCard(buildId))).toContainText("fix-a");
  await expect(card).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.menuBuildsLive)).toHaveCount(0);
});

test("while a build runs and after it is built, the blueprint card, the editor and the canvas show nothing about it, and Build stays enabled", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
  });
  const { window } = launched;
  await openBlueprint(window, flowId);
  const pendingId = await startBuild(window, "fix-a");
  await toBuilds(window);
  const card = window.getByTestId(pageTestIds.buildingCard(pendingId));
  await expect(card).toContainText("Building · step 3 of 5", { timeout: watchMs });

  const expectNothingAboutTheBuild = async () => {
    await window.getByTestId("menu-blueprints").click();
    const blueprint = window.getByTestId(pageTestIds.blueprintCard(flowId));
    await expect(blueprint).toBeVisible();
    await expect(blueprint).not.toContainText(/Building|Built|Needs you|Failed/);
    await openBlueprint(window, flowId);
    await expect(window.getByTestId("node-s1")).toBeVisible();
    await expect(window.getByTestId("node-status-s1")).toHaveCount(0);
    await expect(window.getByText(/Building ·|Built v|Built ·/)).toHaveCount(0);
    await expect(window.getByTestId(controlTestIds.build)).toBeEnabled();
  };

  await expectNothingAboutTheBuild();
  await window.getByTestId(controlTestIds.back).click();
  await toBuilds(window);
  await expect(card).toContainText("Building · step", { timeout: watchMs });

  await expect.poll(() => builtIdNamed("fix-a"), { timeout: watchMs }).toBeDefined();
  await expect(window.getByTestId(pageTestIds.buildCard(builtIdNamed("fix-a") ?? ""))).toBeVisible({
    timeout: watchMs,
  });
  await expectNothingAboutTheBuild();
});

test("a build whose first check fails shows a round 2 lane, round 1 Verify shows the failure lines, and an agent row shows only that agent's activity", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", twoAgents(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    unfilledInRound1: "plugin/agents/s1.md",
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  const progress = window.getByTestId(pageTestIds.buildProgress(pendingId));
  await expect(progress).toBeVisible();
  await expect(window.getByTestId(pageTestIds.buildBuiltLink(pendingId))).toBeVisible({
    timeout: watchMs,
  });
  const round2Write = window.getByTestId(pageTestIds.buildStage(pendingId, 3, 2));
  await expect(round2Write).toContainText("3 Write · round 2");
  await expect(round2Write).toContainText("done");
  await expect(window.getByTestId(pageTestIds.buildStage(pendingId, 5, 2))).toContainText(
    "5 Verify · round 2",
  );

  const round1Verify = window.getByTestId(pageTestIds.buildStage(pendingId, 5, 1));
  await expect(round1Verify).toContainText("failed");
  await round1Verify.click();
  const log = window.getByTestId(pageTestIds.buildActivity(pendingId));
  await expect(log).toContainText("plugin/agents/s1.md body: body has nothing beyond its draft");

  await window.getByTestId(pageTestIds.buildStage(pendingId, 3, 1)).click();
  await expect(log).toContainText("plugin/agents/s1.md");
  await expect(log).toContainText("plugin/agents/s2.md");
  await window.getByTestId(pageTestIds.buildRow(pendingId, 3, 1, "plugin/agents/s2.md")).click();
  await expect(log).toContainText("plugin/agents/s2.md");
  await expect(log).not.toContainText("plugin/agents/s1.md");
});

test("a build that ends needing you shows a Needs you card on Builds, its page shows the questions, and Rebuild with answers starts a new build listed as building", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    pieceMs,
    question: { nodeId: "s1", otherNodeId: "s0", text: "Which command runs the tests?" },
  });
  const { window } = launched;
  await openBlueprint(window, flowId);

  const pendingId = await startBuild(window, "fix-a");

  await toBuilds(window);
  const card = window.getByTestId(pageTestIds.buildingCard(pendingId));
  await expect(card).toContainText("Needs you", { timeout: watchMs });
  await card.click();
  const question = window.getByTestId(pageTestIds.buildQuestion(pendingId, 0));
  await expect(question).toContainText("s1 · s0");
  await expect(question).toContainText("Which command runs the tests?");

  const answer = window.getByTestId(pageTestIds.buildAnswer(pendingId, 0));
  const rebuild = window.getByTestId(pageTestIds.buildRebuild(pendingId));
  await expect(rebuild).toBeDisabled();
  await answer.fill("npm test");
  await expect(rebuild).toBeEnabled();
  await rebuild.click();

  const rebuilt = () =>
    rows<{ id: string; name: string; origin_json: string }>(
      "SELECT id, name, origin_json FROM pending_builds WHERE flow_id = ? AND id != ?",
      flowId,
      pendingId,
    );
  await expect.poll(() => rebuilt().length).toBe(1);
  const [next] = rebuilt();
  expect(next?.name).toBe("fix-a");
  expect(next?.origin_json).toContain("npm test");

  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildingCard(next?.id ?? ""))).toContainText(
    "Building · step",
    { timeout: watchMs },
  );
});

test("the build terminal shows the fd-build session, and Stop ends the build and removes its workspace", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
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
  await expect(window.getByTestId(pageTestIds.buildStage(pendingId, 3, 1))).toContainText(
    "running",
    { timeout: watchMs },
  );
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
  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildingCard(pendingId))).toContainText("Stopped");
});

test("the pipeline page shows the build's tokens and cost read from its session's transcript", async () => {
  test.setTimeout(90_000);
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
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
