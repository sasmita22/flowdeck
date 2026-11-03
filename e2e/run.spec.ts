import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStatus, type RunEvent } from "../src/core/run/run-events.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";
import { buildAndRun } from "./build-run.js";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const twoScripts = () =>
  JSON.parse(
    readFileSync(new URL("../test/fixtures/app-run-two-scripts.json", import.meta.url), "utf8"),
  ) as unknown;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-r-"));
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

test("Build saves the edit first, the build runs, and the run shows each node's status", async () => {
  seedFlow(home, twoScripts(), repo.path);
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();

  await window.getByTestId("node-s2").click();
  await window.getByTestId("canvas-delete").click();
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();

  const buildId = await buildAndRun(window, home, "edited");

  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("node-status-s2")).toHaveCount(0);

  const app = launched;
  launched = undefined;
  await app.close();

  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM flow_versions").get()).toEqual({ n: 2 });

    const builds = db.prepare("SELECT id, dir FROM builds").all() as {
      id: string;
      dir: string;
    }[];
    expect(builds).toEqual([{ id: buildId, dir: join(home, "workspaces", buildId) }]);
    const run = db
      .prepare("SELECT id, build_id, build_dir FROM runs ORDER BY created_at DESC, rowid DESC")
      .get() as { id: string; build_id: string | null; build_dir: string };
    expect(run).toMatchObject({ build_id: buildId, build_dir: builds[0]?.dir });

    expect(
      db.prepare("SELECT node_id, finished_at FROM run_nodes WHERE run_id = ?").all(run.id),
    ).toEqual([{ node_id: "s1", finished_at: expect.any(String) }]);

    const events = (
      db
        .prepare(
          "SELECT kind, payload FROM events WHERE run_id = ? AND node_id = 's1' ORDER BY seq",
        )
        .all(run.id) as { kind: string; payload: string | null }[]
    ).map(
      ({ kind, payload }) =>
        ({ kind, ...(payload === null ? {} : { payload: JSON.parse(payload) }) }) as RunEvent,
    );
    expect(nodeStatus(events)).toBe("done");
  } finally {
    db.close();
  }
});

test("A script-only run has no terminal: the menu's Open terminal stays disabled and the run's Terminal tab says so", async () => {
  seedFlow(home, twoScripts(), repo.path);
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();
  await window.getByTestId("menu-more").click();
  await expect(window.getByTestId("terminal-open")).toBeDisabled();
  await window.keyboard.press("Escape");

  await buildAndRun(window, home, "scripts");

  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("node-status-s2")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await window.getByTestId("run-tab-terminal").click();
  await expect(window.getByTestId("terminal-unavailable")).toBeVisible();
  await expect(window.getByTestId("terminal-view")).toHaveCount(0);
  await window.getByTestId("run-tab-activity").click();

  const session = window.getByTestId("inspector-session");
  await expect(session).toContainText("main");
  await expect(session).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId("inspector-node-s1")).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId("inspector-node-s2")).toHaveAttribute("data-status", "done");
  await expect(window.locator('[data-kind="output"][data-node-id="s1"]')).toContainText(
    "Output: one",
  );
});
