import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitFolderState } from "../src/adapters/git/git-state.js";
import { GitWorktree } from "../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../src/adapters/node-fs/node-file-system.js";
import { SqliteFlowStore } from "../src/adapters/sqlite/flows.js";
import { openDatabase } from "../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../src/adapters/sqlite/sqlite-store.js";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { buildVersion } from "../src/core/compiler/build-version.js";
import type { Flow } from "../src/core/flow/schema.js";
import { fakeBuildDeps } from "../test/fixtures/fake-build-deps.js";
import {
  agent,
  branch,
  fork,
  gate,
  join as joinNode,
  onWorkspaceMainFlow,
  output,
  thenWire,
  trigger,
  wire,
  workspaceFlow,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { fakeClaudeDispatched, launchWithFakeClaude, type FakeAgentTurn } from "./fake-claude.js";
import { buildAndRun, buildOnCanvas, runIdOf } from "./build-run.js";
import { endSessionsOfHome } from "./own-sessions.js";
import { sessionWorktree } from "../src/core/run/workspace.js";

const placed = (built: Flow): Flow => ({
  ...built,
  nodes: built.nodes.map((node, index) => ({
    ...node,
    position: { x: index * 240, y: (index % 2) * 120 },
  })),
});

const laidOut = (nodes: unknown[], wires: unknown[]) => placed(onWorkspaceMainFlow(nodes, wires));

const run = promisify(execFile);

let home: string;
let repo: TmpRepo;
let bin: string;
let launched: LaunchedApp | undefined;

const named = (id: string, label = id) => ({ ...agent(id), label });

const fakeClaude = `
const sock = process.env.FLOWDECK_SOCK ?? "";
const session = sock.slice(sock.lastIndexOf("/") + 1).replace(/\\.sock$/, "");
let typed = "";
const draw = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[HFake Claude in " + session + "\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n",
  );
process.stdout.on("resize", draw);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") typed = "";
    else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const launch = async (ownBin?: string, turns?: Record<string, FakeAgentTurn>) => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    ...(ownBin === undefined ? {} : { ownBin }),
    ...(turns === undefined ? {} : { turns }),
  });
  await expect(launched.window.getByTestId(controlTestIds.build)).toBeVisible();
  return launched.window;
};

const withFakeClaude = async () => {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  return launch(bin);
};

const closeApp = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
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
  rows<{ id: string; status: string; inputs: string; tmux_name: string }>(
    `SELECT runs.id, runs.status, runs.inputs, run_sessions.tmux_name
       FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
      ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT 1`,
  )[0];

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

const workFolder = (buildId: string) =>
  sessionWorktree(join(home, "workspaces", buildId), "main", repo.path);

const shownRun = () => {
  const runId = latestRun()?.id;
  if (runId === undefined) throw new Error("no run was recorded");
  return runId;
};

const status = (window: Page, nodeId: string) =>
  window.getByTestId(pageTestIds.runStageStatus(shownRun(), nodeId));

const manifestNodeIds = (buildId: string) =>
  rows<{ manifest_json: string }>(
    "SELECT manifest_json FROM build_manifests WHERE build_id = ?",
    buildId,
  )
    .flatMap(
      (row) =>
        (
          JSON.parse(row.manifest_json) as {
            containers: { kind: string; nodes: { id: string }[] }[];
          }
        ).containers.find(({ kind }) => kind === "workspace")?.nodes ?? [],
    )
    .map((node) => node.id);

const replyOf = (runId: string, nodeId: string) =>
  rows<{ payload: string | null }>(
    "SELECT payload FROM events WHERE run_id = ? AND node_id = ? AND kind = 'done'",
    runId,
    nodeId,
  ).map((row) => (JSON.parse(row.payload ?? "{}") as { stopMessage?: string }).stopMessage)[0];

const darkShot = async (window: Page, name: string) => {
  await window.emulateMedia({ colorScheme: "dark" });
  await window.screenshot({ path: test.info().outputPath(name) });
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rv-"));
  repo = await createTmpRepo({ commit: true });
  bin = join(home, "bin");
});

test.afterEach(async () => {
  try {
    await closeApp();
  } finally {
    try {
      await endSessionsOfHome(home);
      await rm(home, { recursive: true, force: true });
    } finally {
      await repo.cleanup();
    }
  }
});

test("The run page shows each stage with its status, and no canvas or Open blueprint", async () => {
  seedFlow(
    home,
    laidOut([named("s1", "Plan"), named("s2", "Ship")], [thenWire("s1", "s2")]),
    repo.path,
  );
  const window = await launch();

  const buildId = await buildAndRun(window, home, "stages");
  const runId = await runIdOf(home, buildId);

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  const stageIds = manifestNodeIds(buildId);
  expect(stageIds).toEqual(expect.arrayContaining(["s1", "s2"]));
  for (const nodeId of stageIds) {
    await expect(window.getByTestId(pageTestIds.runStageStatus(runId, nodeId))).toHaveAttribute(
      "data-status",
      "done",
    );
  }
  await expect(window.getByRole("list", { name: "workspace stages" })).toBeVisible();
  await expect(window.locator(".react-flow")).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Open blueprint" })).toHaveCount(0);
  await darkShot(window, "stages.png");
});

test("A blueprint that has run shows no run status on the editor canvas; its run page does", async () => {
  const { flowId } = seedFlow(home, laidOut([named("s1", "Plan")], []), repo.path);
  const window = await launch();

  const buildId = await buildAndRun(window, home, "no-editor-status");
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId(pageTestIds.runStageStatus(runId, "s1"))).toHaveAttribute(
    "data-status",
    "done",
  );

  await window.getByTestId(pageTestIds.runBack).click();
  await window.getByTestId("menu-blueprints").click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
  await expect(window.getByTestId("node-s1")).toBeVisible();
  await expect(window.locator('[data-testid^="node-status-"]')).toHaveCount(0);
});

test("The picture of the blueprint sits above the stages, collapsed until opened", async () => {
  seedFlow(
    home,
    laidOut([named("s1", "Plan"), named("s2", "Ship")], [thenWire("s1", "s2")]),
    repo.path,
  );
  const window = await launch();

  const buildId = await buildAndRun(window, home, "pictured");
  const runId = await runIdOf(home, buildId);

  await expect(window.getByTestId(pageTestIds.runStageStatus(runId, "s2"))).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 20_000 },
  );
  const toggle = window.getByTestId(pageTestIds.buildPictureToggle(buildId));
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(window.getByTestId(pageTestIds.buildPictureImage(buildId))).toHaveCount(0);
  const picture = await toggle.boundingBox();
  const stages = await window.getByRole("list", { name: "workspace stages" }).boundingBox();
  if (picture === null || stages === null) throw new Error("the picture or the stages are hidden");
  expect(picture.y + picture.height).toBeLessThanOrEqual(stages.y);

  await toggle.click();

  await expect(window.getByTestId(pageTestIds.buildPictureImage(buildId))).toBeVisible();
});

test("A failing Agent's stage shows it failed with its reason, and its Retry runs it to done", async () => {
  seedFlow(
    home,
    laidOut([named("s1", "Run tests"), named("s2", "Ship")], [thenWire("s1", "s2")]),
    repo.path,
  );
  const window = await launch(undefined, { s1: "fail-once" });

  const buildId = await buildAndRun(window, home, "fails-once");
  const runId = await runIdOf(home, buildId);

  await expect(window.getByTestId(pageTestIds.runStageStatus(runId, "s1"))).toHaveAttribute(
    "data-status",
    "failed",
    { timeout: 20_000 },
  );
  await window.getByTestId(pageTestIds.runStage(runId, "s1")).click();
  await expect(window.getByTestId(pageTestIds.runStageReason(runId, "s1"))).toHaveText(
    "No finished Agent call for s1",
  );
  await expect(window.getByTestId("inspector-reason-s1")).toHaveText(
    "No finished Agent call for s1",
  );
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("failed");
  await darkShot(window, "failed.png");

  await window.getByTestId(pageTestIds.runStageRetry(runId, "s1")).click();

  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(status(window, "s1")).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");
  await expect(window.getByTestId(pageTestIds.runStageReason(runId, "s1"))).toHaveCount(0);
  expect(
    rows<{ kind: string }>(
      "SELECT kind FROM events WHERE run_id = ? AND node_id = 's1' ORDER BY seq",
      runId,
    ).map((row) => row.kind),
  ).toEqual(["sent", "failed", "retry", "sent", "done"]);
  expect(
    rows("SELECT node_id, finished_at FROM run_nodes WHERE run_id = ? AND node_id = 's1'", runId),
  ).toEqual([{ node_id: "s1", finished_at: expect.any(String) }]);
  expect(latestRun()?.status).toBe("done");
});

test("Against the stages, the gate banner answers, Stop and Resume work, and the Cost tab shows each stage", async () => {
  seedFlow(
    home,
    laidOut(
      [named("s1", "Plan"), gate("g1"), named("s2", "Build"), named("s3", "Ship")],
      [thenWire("s1", "g1"), thenWire("g1", "s2"), thenWire("s2", "s3")],
    ),
    repo.path,
  );
  const window = await launch(undefined, { s2: "hold-once" });

  const buildId = await buildAndRun(window, home, "staged");
  const runId = await runIdOf(home, buildId);
  const stage = (nodeId: string) => window.getByTestId(pageTestIds.runStageStatus(runId, nodeId));

  await expect(stage("g1")).toHaveAttribute("data-status", "needs you", { timeout: 20_000 });
  await window.getByTestId(controlTestIds.inspectorHide).click();
  const banner = window.getByTestId("wait-banner");
  await expect(banner.getByTestId("wait-text")).toHaveText("Check the plan");
  await banner.getByTestId("wait-approve").click();
  await expect(stage("g1")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(stage("s2")).toHaveAttribute("data-status", "sent", { timeout: 20_000 });
  await expect.poll(() => fakeClaudeDispatched(home), { timeout: 20_000 }).toContain("s2");

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  expect(latestRun()?.status).toBe("stopped");
  await expect(stage("s1")).toHaveAttribute("data-status", "done");

  await window.getByTestId(pageTestIds.runResume).click();

  await expect(stage("s3")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");
  expect(latestRun()?.status).toBe("done");

  await window.getByTestId(controlTestIds.inspectorShow).click();
  await window.getByTestId("run-tab-cost").click();

  for (const [nodeId, label] of [
    ["s1", "Plan"],
    ["s2", "Build"],
    ["s3", "Ship"],
  ] as const) {
    await expect(window.getByTestId(`cost-node-${nodeId}`)).toContainText(label);
  }
});

test("Selecting a stage shows only that stage's activity and its final reply", async () => {
  seedFlow(
    home,
    laidOut([named("s1", "Plan"), named("s2", "Ship")], [thenWire("s1", "s2")]),
    repo.path,
  );
  const window = await launch();

  const buildId = await buildAndRun(window, home, "selected");
  const runId = await runIdOf(home, buildId);

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  expect(
    rows<{ node_id: string }>(
      "SELECT DISTINCT node_id FROM activity WHERE run_id = ? ORDER BY node_id",
      runId,
    ).map((row) => row.node_id),
  ).toEqual(expect.arrayContaining(["s1", "s2"]));

  for (const [chosen, other] of [
    ["s2", "s1"],
    ["s1", "s2"],
  ] as const) {
    const reply = replyOf(runId, chosen);
    expect(reply).toEqual(expect.any(String));

    await window.getByTestId(pageTestIds.runStage(runId, chosen)).click();

    const detail = window.getByTestId(pageTestIds.runStageDetail(runId, chosen));
    await expect(detail).toBeVisible();
    await expect(window.getByTestId(pageTestIds.runStageDetail(runId, other))).toHaveCount(0);
    await expect(detail.locator('[data-testid^="activity-entry-"]').first()).toBeVisible();
    await expect(
      detail.locator(`[data-testid^="activity-entry-"]:not([data-node-id="${chosen}"])`),
    ).toHaveCount(0);
    await expect(window.getByTestId(pageTestIds.runStageReply(runId, chosen))).toHaveText(
      reply ?? "",
    );
  }
});

test("An Agent stage lists its subagent's step with the time to the second, and its detail shows the input and output", async () => {
  seedFlow(home, laidOut([named("s1", "Plan")], []), repo.path);
  const window = await launch();

  const buildId = await buildAndRun(window, home, "traced");
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });

  const steps = rows<{ id: number; node_id: string; entry: string }>(
    `SELECT id, node_id, entry FROM activity AS latest
      WHERE run_id = ?
        AND seq = (SELECT MAX(seq) FROM activity WHERE run_id = latest.run_id AND id = latest.id)`,
    runId,
  ).filter((row) => {
    const entry = JSON.parse(row.entry) as { kind: string; tool?: string; summary: string };
    return entry.kind === "tool" && entry.tool === "Bash" && entry.summary === "echo traced";
  });
  expect(steps.map((row) => row.node_id)).toEqual(["s1"]);
  const stepId = steps[0]?.id ?? -1;

  await window.getByTestId(pageTestIds.runStage(runId, "s1")).click();
  const detail = window.getByTestId(pageTestIds.runStageDetail(runId, "s1"));
  await expect(detail.getByTestId(`activity-entry-${stepId}`)).toHaveAttribute(
    "data-node-id",
    "s1",
  );
  await expect(detail.getByTestId(`activity-entry-${stepId}-time`)).toHaveText(
    /^\d{2}:\d{2}:\d{2}$/,
  );
  const stepDetail = detail.getByTestId(`activity-entry-${stepId}-detail`);
  await stepDetail.locator("summary").click();
  await expect(detail.getByTestId(`activity-entry-${stepId}-input`)).toContainText("echo traced");
  await expect(detail.getByTestId(`activity-entry-${stepId}-output`)).toContainText(
    '"stdout":"traced',
  );
});

test("A step cut short shows its full text on request; a short step has no such control", async () => {
  seedFlow(home, laidOut([named("s1", "Plan")], []), repo.path);
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    stepOutputChars: 5000,
  });
  const window = launched.window;
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();

  const buildId = await buildAndRun(window, home, "long");
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });

  const entries = rows<{ id: number; entry: string }>(
    `SELECT id, entry FROM activity AS latest
      WHERE run_id = ? AND node_id = 's1'
        AND seq = (SELECT MAX(seq) FROM activity WHERE run_id = latest.run_id AND id = latest.id)`,
    runId,
  ).map((row) => ({ id: row.id, ...(JSON.parse(row.entry) as { kind: string; tool?: string }) }));
  const longStep = entries.find((entry) => entry.kind === "tool" && entry.tool === "Bash")?.id;
  const shortStep = entries.find((entry) => entry.kind === "subagent")?.id;
  expect(longStep).toEqual(expect.any(Number));
  expect(shortStep).toEqual(expect.any(Number));

  await window.getByTestId(pageTestIds.runStage(runId, "s1")).click();
  const detail = window.getByTestId(pageTestIds.runStageDetail(runId, "s1"));
  await detail.getByTestId(`activity-entry-${longStep}-summary`).click();
  await detail.getByTestId(`activity-entry-${shortStep}-summary`).click();

  const output = detail.getByTestId(`activity-entry-${longStep}-output`);
  await expect(output).toContainText("… cut,");
  await expect(output).not.toContainText("END-OF-FULL-OUTPUT");
  const fullText = detail.getByTestId(`activity-entry-${longStep}-full-text`);
  await expect(fullText).toHaveAttribute("data-node-id", "s1");
  await expect(detail.getByTestId(`activity-entry-${shortStep}-output`)).toBeVisible();
  await expect(detail.getByTestId(`activity-entry-${shortStep}-full-text`)).toHaveCount(0);
  await expect(
    detail.locator('[data-testid^="activity-entry-"]:not([data-node-id="s1"])'),
  ).toHaveCount(0);

  await fullText.click();

  await expect(output).toContainText("END-OF-FULL-OUTPUT");
  await expect(output).not.toContainText("… cut,");
});

test("Stop ends a long agent turn and marks the run stopped, and Resume skips the finished nodes", async () => {
  seedFlow(
    home,
    laidOut([agent("s1"), agent("s2"), agent("s3")], [thenWire("s1", "s2"), thenWire("s2", "s3")]),
    repo.path,
  );
  const window = await launch(undefined, { s2: "hold-once" });
  await buildAndRun(window, home, "long");
  await expect(status(window, "s2")).toHaveAttribute("data-status", "sent", {
    timeout: 20_000,
  });
  await expect.poll(() => fakeClaudeDispatched(home), { timeout: 20_000 }).toContain("s2");

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  expect(latestRun()?.status).toBe("stopped");

  await window.getByTestId(pageTestIds.runResume).click();

  await expect(status(window, "s3")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");
  expect((await fakeClaudeDispatched(home)).filter((id) => id === "s1")).toEqual(["s1"]);
  expect(
    rows<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE run_id = ? AND node_id = 's1' AND kind = 'sent'",
      latestRun()?.id,
    ),
  ).toEqual([{ n: 1 }]);
});

test("A skippable Gate is passed in an automatic run and stops in a normal one, chosen in the Run dialog", async () => {
  seedFlow(
    home,
    laidOut(
      [
        agent("s1"),
        gate("g1", { settings: { shown: "Check the plan", skippable: true } }),
        agent("s2"),
      ],
      [thenWire("s1", "g1"), thenWire("g1", "s2")],
    ),
    repo.path,
  );
  const window = await launch();

  const buildId = await buildOnCanvas(window, home, "gated");
  await window.getByTestId(pageTestIds.buildDetailRun).click();
  const dialog = window.getByTestId("run-dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(
    "Skips gates marked ‘skip in automatic runs’. Hard stops still stop.",
  );
  await window.getByTestId("run-dialog-auto").check();
  await darkShot(window, "run-dialog.png");
  await window.getByTestId("run-dialog-start").click();
  await runIdOf(home, buildId);

  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(status(window, "g1")).toHaveAttribute("data-status", "skipped");
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({ auto: true });

  await window.getByTestId(pageTestIds.runAgain).click();
  await expect(dialog).toBeVisible();
  await expect(window.getByTestId("run-dialog-auto")).not.toBeChecked();
  await window.getByTestId("run-dialog-start").click();

  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });
  await expect(status(window, "g1")).toHaveAttribute("data-status", "needs you");
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({});
  await window.getByTestId("wait-approve").click();
  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
});

test("A build whose yes/no value is no takes Branch's no path", async () => {
  const branched = placed(
    workspaceFlow(
      [trigger("t"), branch("b", "deep"), agent("yes"), agent("no"), output("stop")],
      [
        thenWire("t", "b"),
        wire("b", "yes", "yes", "in"),
        wire("b", "no", "no", "in"),
        thenWire("yes", "stop"),
        thenWire("no", "stop"),
      ],
    ),
  );
  seedFlow(home, branched, repo.path);
  const window = await launch();

  const buildId = await buildAndRun(window, home, "quick", { deep: false });

  await expect(status(window, "no")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(status(window, "yes")).toHaveAttribute("data-status", "skipped");
  await expect(status(window, "t")).toHaveAttribute("data-status", "done");
  expect(rows<{ values: string }>('SELECT "values" FROM builds WHERE id = ?', buildId)).toEqual([
    { values: JSON.stringify({ deep: false }) },
  ]);
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({});
});

test("Stopping a run that waits at a Gate makes its stage and the status bar read stopped, not needs you", async () => {
  seedFlow(
    home,
    laidOut([agent("s1"), gate("g1"), agent("s2")], [thenWire("s1", "g1"), thenWire("g1", "s2")]),
    repo.path,
  );
  const window = await launch();
  const buildId = await buildAndRun(window, home, "gated");
  const runId = await runIdOf(home, buildId);
  const statusBar = window.getByTestId("run-status");
  const gateStage = window.getByTestId(pageTestIds.runStageStatus(runId, "g1"));
  await expect(gateStage).toHaveAttribute("data-status", "needs you", { timeout: 20_000 });
  await expect(statusBar).toContainText("Needs you");

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  await expect(gateStage).toHaveAttribute("data-status", "stopped");
  await expect(statusBar).not.toContainText(/needs you/i);
  await expect(statusBar).toHaveText(/^Stopped/);
});

test("A gate's question shows on the run page while the inspector is hidden", async () => {
  seedFlow(
    home,
    laidOut([agent("s1"), gate("g1"), agent("s2")], [thenWire("s1", "g1"), thenWire("g1", "s2")]),
    repo.path,
  );
  const window = await launch();
  await buildAndRun(window, home, "gated");
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });

  await window.getByTestId(controlTestIds.inspectorHide).click();

  await expect(window.getByTestId("inspector")).toHaveCount(0);
  const banner = window.getByTestId("wait-banner");
  await expect(banner).toBeVisible();
  await expect(banner.getByTestId("wait-text")).toHaveText("Check the plan");
  await expect(window.getByTestId("run-status")).toContainText("Needs you");
  await banner.getByTestId("wait-approve").click();
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
});

test("The Cost tab shows each node's tokens, cost and time, and a session line that adds them up", async () => {
  const source = seedBlueprint(
    home,
    "Plan and build",
    laidOut(
      [
        { ...agent("p1"), label: "Plan" },
        named("s1", "Run tests"),
        { ...agent("p2"), label: "Build" },
      ],
      [thenWire("p1", "s1"), thenWire("s1", "p2")],
    ),
    repo.path,
  );
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  let runId: string;
  try {
    let clock = Date.parse("2026-11-02T10:00:00Z");
    const runs = new SqliteStore({ db, now: () => new Date(clock) });
    const fs = new NodeFileSystem();
    const built = await buildVersion(
      source,
      { name: "plan-and-build", values: {} },
      {
        flows: new SqliteFlowStore({ db }),
        store: runs,
        fs,
        home,
        gitState: new GitFolderState(),
        worktree: new GitWorktree(),
        newId: () => "0f3a9c2e-0000-4000-8000-000000000000",
        now: () => clock,
        ...fakeBuildDeps(fs, home),
      },
    );
    if (!built.ok) throw new Error("the seeded flow did not build");
    runId = runs.createRun({
      buildDir: built.dir,
      inputs: {},
      nodeIds: ["start", "p1", "s1", "p2", "stop"],
      session: {
        tmuxName: "fd-run-seeded",
        cwd: workFolder(built.record.id),
        claudeSessionId: "seeded",
      },
      buildId: built.record.id,
    }).id;
    const at = (seconds: number, nodeId: string, event: Parameters<SqliteStore["append"]>[2]) => {
      clock = Date.parse("2026-11-02T10:00:00Z") + seconds * 1000;
      runs.append(runId, nodeId, event);
    };
    at(0, "p1", { kind: "sent" });
    at(42, "p1", { kind: "done" });
    at(43, "s1", { kind: "running" });
    at(51, "s1", { kind: "done" });
    at(52, "p2", { kind: "sent" });
    at(170, "p2", { kind: "done" });
    at(171, "p1", {
      kind: "usage",
      payload: { messages: ["m1", "m2"] },
      tokens: 48_210,
      cost: 0.18,
    });
    at(171, "p2", { kind: "usage", payload: { messages: ["m3"] }, tokens: 131_904, cost: 0.61 });
    runs.finishRun(runId, "done");
  } finally {
    db.close();
  }
  const window = await launch();
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();

  await window.getByTestId("run-tab-cost").click();

  await expect(window.getByTestId("cost-node-p1")).toHaveText(["Plan48.2k$0.1842s"]);
  await expect(window.getByTestId("cost-node-s1")).toHaveText(["Run tests0$0.008s"]);
  await expect(window.getByTestId("cost-node-p2")).toHaveText(["Build131.9k$0.611m 58s"]);
  await expect(window.getByTestId("cost-total")).toHaveText(["Session180.1k$0.792m 50s"]);
  await darkShot(window, "cost.png");
});

test("Fork and Join show their status during a parallel run, and Stop ends the run's tmux session", async () => {
  seedFlow(
    home,
    laidOut(
      [fork("f"), agent("a"), agent("b"), joinNode("j")],
      [thenWire("f", "a"), thenWire("f", "b"), thenWire("a", "j"), thenWire("b", "j")],
    ),
    repo.path,
  );
  const window = await withFakeClaude();

  await buildAndRun(window, home, "parallel");

  await expect(status(window, "f")).toHaveAttribute("data-status", "sent", { timeout: 30_000 });
  await expect(status(window, "j")).toHaveAttribute("data-status", "running");
  await expect(status(window, "a")).toHaveAttribute("data-status", "sent");
  const session = latestRun()?.tmux_name ?? "";
  await expect.poll(() => tmuxAlive(session), { timeout: 15_000 }).toBe(true);

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  await expect.poll(() => tmuxAlive(session)).toBe(false);
});

test("Pop out opens the terminal in its own window, attached to the run's session", async () => {
  seedFlow(home, laidOut([agent("p1")], []), repo.path);
  const window = await withFakeClaude();
  await buildAndRun(window, home, "pop-out");
  await expect(status(window, "p1")).toHaveAttribute("data-status", "sent", { timeout: 30_000 });
  const session = latestRun()?.tmux_name ?? "";

  await window.getByTestId("run-tab-terminal").click();
  await expect(window.getByTestId("terminal-view")).toContainText(`Fake Claude in ${session}`, {
    timeout: 20_000,
  });
  await window.getByTestId("terminal-pop-out").click();

  await expect(window.getByTestId("terminal-popped-out")).toBeVisible();
  const app = launched?.app;
  if (app === undefined) throw new Error("the app is not running");
  const popOutText = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const popOut = BrowserWindow.getAllWindows().find(
        (each) => each.getTitle() === "Flowdeck terminal",
      );
      return popOut === undefined
        ? null
        : ((await popOut.webContents.executeJavaScript(
            "document.querySelector('[data-testid=terminal-view]')?.innerText ?? ''",
          )) as string);
    });
  await expect.poll(popOutText, { timeout: 20_000 }).toContain(`Fake Claude in ${session}`);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);

  await window.getByTestId(pageTestIds.runStop).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
});
