import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow, gate, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildAndRun } from "./build-run.js";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const scriptThenGateThenScript = () =>
  flow(
    [
      script("s1", { settings: { command: "echo", args: ["one"] } }),
      gate("g1"),
      script("s2", { settings: { command: "echo", args: ["two"] } }),
    ],
    [thenWire("s1", "g1"), thenWire("g1", "s2")],
  );

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-ap-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("Approving a gate in the inspector lets the run carry on to the last script", async () => {
  seedFlow(home, scriptThenGateThenScript(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();

  await buildAndRun(window, home, "approve");

  await expect(window.getByTestId("inspector-node-g1")).toHaveAttribute(
    "data-status",
    "needs you",
    { timeout: 20_000 },
  );
  const panel = window.getByTestId("wait-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-kind", "gate");
  await expect(window.getByTestId("wait-text")).toContainText("Check the plan");

  await window.getByTestId("wait-approve").click();

  await expect(window.getByTestId("inspector-node-g1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("inspector-node-s2")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("wait-panel")).toHaveCount(0);

  const app = launched;
  launched = undefined;
  await app.close();

  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    const run = db.prepare("SELECT id FROM runs ORDER BY created_at DESC, rowid DESC").get() as {
      id: string;
    };
    const decided = (
      db
        .prepare(
          "SELECT payload FROM events WHERE run_id = ? AND node_id = 'g1' AND kind = 'decided'",
        )
        .all(run.id) as { payload: string }[]
    ).map(({ payload }) => JSON.parse(payload) as unknown);
    expect(decided).toEqual([{ nodeId: "g1", decision: "approved" }]);

    expect(
      db
        .prepare("SELECT node_id FROM run_nodes WHERE run_id = ? AND finished_at IS NOT NULL")
        .all(run.id),
    ).toContainEqual({ node_id: "s2" });
  } finally {
    db.close();
  }
});

test("A gate's question shows on the run's page even when a node was selected in the editor", async () => {
  seedFlow(home, scriptThenGateThenScript(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();

  await window.getByTestId("node-s2").click();
  await expect(window.getByTestId("node-settings")).toBeVisible();
  await buildAndRun(window, home, "approve");

  await expect(window.getByTestId("run-page-status")).toBeVisible();
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId("node-settings")).toHaveCount(0);
  await window.getByTestId("wait-approve").click();
  await expect(window.getByTestId("wait-panel")).toHaveCount(0, { timeout: 20_000 });
});
