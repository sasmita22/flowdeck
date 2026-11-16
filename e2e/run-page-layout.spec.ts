import { expect, test, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../src/adapters/sqlite/sqlite-store.js";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, flow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { killRunSessions } from "./run-sessions.js";

type Box = { x: number; y: number; width: number; height: number };

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rl-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

const seedInterruptedRunWithoutStages = (): string => {
  seedBlueprint(home, "Alpha", flow([agent("p1")], []), repo.path);
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  try {
    db.prepare(
      "INSERT INTO builds (id, hash, name, repo, dir, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("stale-build", "stalehash", "stale", repo.path, "/nowhere", 1);
    return new SqliteStore({ db }).createRun({
      buildDir: "/nowhere",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run-gone", cwd: repo.path, claudeSessionId: "gone" },
      buildId: "stale-build",
    }).id;
  } finally {
    db.close();
  }
};

const boxOf = async (name: string, locator: Locator): Promise<[string, Box]> => {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${name} has no bounding box`);
  return [name, box];
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("An interrupted run with no recorded stages shows its note clear of the Story panel, the not-recorded line and the picture button", async () => {
  const runId = seedInterruptedRunWithoutStages();
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("interrupted");

  const [, note] = await boxOf("interrupted note", window.getByTestId(pageTestIds.runPageNote));
  const others = [
    await boxOf("Story panel", window.getByTestId(pageTestIds.runStory)),
    await boxOf("not-recorded line", window.getByTestId(pageTestIds.runStagesNotRecorded)),
    await boxOf(
      "picture button",
      window.getByTestId(pageTestIds.buildPictureToggle("stale-build")),
    ),
  ];
  await window.screenshot({ path: test.info().outputPath("run-page.png") });

  const overlapping = others.flatMap(([name, box]) =>
    overlaps(note, box)
      ? [`interrupted note ${JSON.stringify(note)} overlaps ${name} ${JSON.stringify(box)}`]
      : [],
  );
  expect(overlapping).toEqual([]);
});
