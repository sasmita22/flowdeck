import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeStatus, type RunEvent } from "../src/core/run/run-events.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let folder: string;
let logDir: string;
let launched: LaunchedApp | undefined;

const twoScripts = () =>
  JSON.parse(
    readFileSync(new URL("../test/fixtures/app-run-two-scripts.json", import.meta.url), "utf8"),
  ) as unknown;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-r-"));
  folder = await realpath(await mkdtemp(join(tmpdir(), "fd-r-wf-")));
  logDir = await mkdtemp(join(tmpdir(), "fd-r-log-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test("Run saves the edit first, builds it, runs it and shows each node's status", async () => {
  seedFlow(home, twoScripts(), folder);
  launched = await launchApp({ home, logPath: join(logDir, "app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-run")).toBeVisible();

  await window.getByTestId("node-s2").click();
  await window.getByTestId("canvas-delete").click();
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();

  await window.getByTestId("canvas-run").click();

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

    const builds = db.prepare("SELECT hash, dir FROM builds").all() as {
      hash: string;
      dir: string;
    }[];
    expect(builds).toHaveLength(1);
    const [build] = builds;
    const run = db
      .prepare("SELECT id, build_hash, build_dir FROM runs ORDER BY created_at DESC, rowid DESC")
      .get() as { id: string; build_hash: string | null; build_dir: string };
    expect(run).toMatchObject({ build_hash: build?.hash, build_dir: build?.dir });

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

test("Open terminal stays disabled through a script-only run, and no pane appears", async () => {
  seedFlow(home, twoScripts(), folder);
  launched = await launchApp({ home, logPath: join(logDir, "app.log") });
  const { window } = launched;
  await expect(window.getByTestId("canvas-run")).toBeVisible();
  await expect(window.getByTestId("terminal-open")).toBeDisabled();

  await window.getByTestId("canvas-run").click();

  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("node-status-s2")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("terminal-open")).toBeDisabled();
  await expect(window.getByTestId("terminal-view")).toHaveCount(0);
});
