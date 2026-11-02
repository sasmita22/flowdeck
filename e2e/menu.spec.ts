import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlTestIds,
  pageTestIds,
  paletteTestId,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import { flow, gate, prompt, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";
import { openDatabase } from "../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../src/adapters/sqlite/sqlite-store.js";

const secret = "xoxb-fd59-never-shown";

let home: string;
let folder: string;
let claudeConfig: string;
let launched: LaunchedApp | undefined;

const twoScripts = () =>
  JSON.parse(
    readFileSync(new URL("../test/fixtures/app-run-two-scripts.json", import.meta.url), "utf8"),
  ) as unknown;

const withConnectors = (connectors: string[]) => {
  const base = flow([prompt("p1")], []);
  return { ...base, session: { ...base.session, connectors } };
};

const launch = async () => {
  launched = await launchApp({
    home,
    logPath: test.info().outputPath("app.log"),
    env: { FLOWDECK_CLAUDE_CONFIG: claudeConfig },
  });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched;
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

const closeApp = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
};

const shot = async (target: LaunchedApp, testInfo: TestInfo, name: string) => {
  const { window } = target;
  await window.emulateMedia({ colorScheme: null });
  await target.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
  });
  await window.waitForFunction(() => innerWidth === 1280 && innerHeight === 800);
  await window.evaluate(() => document.fonts.ready);
  await window.mouse.move(1, 1);
  const path = testInfo.outputPath(`${name}.png`);
  await window.screenshot({ path });
  await writeFile(
    testInfo.outputPath(`${name}.aria.yml`),
    await window.locator("body").ariaSnapshot(),
  );
  await testInfo.attach(`${name}.png`, { path, contentType: "image/png" });
};

const drop = (window: Page, type: Parameters<typeof paletteTestId>[0], x: number) =>
  window.getByTestId(paletteTestId(type)).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x, y: 150 },
  });

const rename = async (window: Page, name: string) => {
  const title = window.getByTestId(controlTestIds.title);
  await title.fill(name);
  await title.press("Enter");
  await expect(title).toHaveValue(name);
};

const saveNow = async (window: Page) => {
  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);
};

const readout = (window: Page) => window.getByTestId(readoutTestIds.flow);

const byPrefix = (window: Page, prefix: string, text?: string): Locator => {
  const all = window.locator(`[data-testid^="${prefix}"]`);
  return text === undefined ? all : all.filter({ hasText: text });
};

const dbRows = <T>(sql: string): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-menu-"));
  folder = await realpath(await mkdtemp(join(tmpdir(), "fd-menu-wf-")));
  claudeConfig = join(home, "claude.json");
  await writeFile(
    claudeConfig,
    JSON.stringify({
      mcpServers: { slack: { command: "slack-mcp", env: { SLACK_TOKEN: secret } } },
    }),
  );
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test("Two blueprints each keep their own canvas, after a reload too", async () => {
  const testInfo = test.info();
  let { window } = await launch();

  await rename(window, "Alpha");
  await drop(window, "prompt", 200);
  await saveNow(window);

  await window.getByTestId(controlTestIds.back).click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  await window.getByTestId(pageTestIds.create).click();
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Untitled");
  await expect(readout(window)).not.toContainText('"prompt-1"');
  await rename(window, "Beta");
  await drop(window, "script", 200);
  await saveNow(window);

  await drop(window, "prompt", 420);
  await window.getByTestId(controlTestIds.back).click();
  await expect(byPrefix(window, "blueprint-card-")).toHaveCount(2);
  await byPrefix(window, "blueprint-open-", "Alpha").click();
  await window.getByTestId(pageTestIds.leaveDiscard).click();
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Alpha");
  await expect(readout(window)).toContainText('"id":"prompt-1"');
  await expect(readout(window)).not.toContainText('"script-1"');

  ({ window } = await relaunch());
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Beta");
  await expect(readout(window)).toContainText('"id":"script-1"');
  await expect(readout(window)).not.toContainText('"prompt-1"');

  await window.getByTestId(controlTestIds.back).click();
  const betaId = (
    await byPrefix(window, "blueprint-card-", "Beta").getAttribute("data-testid")
  )?.slice("blueprint-card-".length);
  if (betaId === undefined) throw new Error("no Beta card");
  await window.getByTestId(pageTestIds.blueprintRename(betaId)).click();
  const input = window.getByTestId(pageTestIds.blueprintNameInput(betaId));
  await input.fill("Beta report");
  await input.press("Enter");
  await expect(byPrefix(window, "blueprint-open-", "Beta report")).toBeVisible();
  await expect(byPrefix(window, "blueprint-card-", "Alpha")).toContainText("1 version");
  if (launched !== undefined) await shot(launched, testInfo, "blueprints");

  await byPrefix(window, "blueprint-open-", "Beta report").click();
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Beta report");
  await window.getByTestId(controlTestIds.back).click();
  await byPrefix(window, "blueprint-open-", "Alpha").click();
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Alpha");
  await expect(readout(window)).toContainText('"id":"prompt-1"');

  await closeApp();
  expect(
    dbRows<{ name: string; versions: number }>(
      `SELECT name, (SELECT count(*) FROM flow_versions WHERE flow_id = flows.id) AS versions
         FROM flows ORDER BY name`,
    ),
  ).toEqual([
    { name: "Alpha", versions: 1 },
    { name: "Beta report", versions: 1 },
  ]);
});

test("Build a saved version, read its files, run it from Builds, then reopen and rerun the run", async () => {
  const testInfo = test.info();
  const planner = seedBlueprint(home, "Planner", withConnectors(["slack"]), folder);
  seedBlueprint(home, "Scripts", twoScripts(), folder);
  const target = await launch();
  const { window } = target;
  await expect(window.getByTestId(controlTestIds.title)).toHaveValue("Scripts");

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId(pageTestIds.blueprintBuild(planner.flowId)).click();
  await expect(window.getByTestId(pageTestIds.title)).toContainText("Planner v1");
  await expect(window.getByTestId(pageTestIds.buildFile("manifest.json"))).toBeVisible();
  await expect(window.getByTestId(pageTestIds.buildFileContent)).toContainText('"slack"');
  await window.getByTestId(pageTestIds.buildFile("commands/p1.md")).click();
  await expect(window.getByTestId(pageTestIds.buildFileContent)).toContainText("Do the work.");
  await expect(window.getByTestId(pageTestIds.buildFile("commands/p1.md"))).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(window.locator('[data-testid^="build-file-"][aria-current]')).toHaveCount(1);
  await shot(target, testInfo, "build-files");
  for (const row of await window.locator('[data-testid^="build-file-"]').all()) {
    if ((await row.getAttribute("data-testid")) === pageTestIds.buildFileContent) continue;
    await row.click();
    await expect(window.getByTestId(pageTestIds.buildFileContent)).not.toContainText(secret);
  }
  await expect(window.locator("body")).not.toContainText(secret);

  await window.getByTestId(pageTestIds.buildBack).click();
  await window.getByTestId("menu-blueprints").click();
  await byPrefix(window, "blueprint-open-", "Scripts").click();
  await window.getByTestId(controlTestIds.build).click();
  await expect(window.getByTestId(controlTestIds.built)).toHaveText(/^Built v1 · [0-9a-f]{7}$/);
  const shortScriptsHash = ((await window.getByTestId(controlTestIds.built).textContent()) ?? "")
    .split(" · ")
    .at(-1);

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-builds").click();
  await expect(byPrefix(window, "build-card-")).toHaveCount(2);
  const scriptsCard = byPrefix(window, "build-card-", "Scripts");
  await expect(scriptsCard).toContainText("v1");
  await expect(scriptsCard).toContainText(shortScriptsHash ?? "missing");
  await shot(target, testInfo, "builds");
  await scriptsCard.locator('[data-testid^="build-run-"]').click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 20_000 },
  );
  await expect(window.getByTestId("node-status-s2")).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId(controlTestIds.search)).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.save)).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.undo)).toHaveCount(0);

  await window.getByTestId(pageTestIds.runBack).click();
  const runCard = byPrefix(window, "run-card-", "Scripts");
  await expect(runCard).toHaveCount(1);
  await expect(runCard.locator('[data-testid^="run-result-"]')).toHaveText("done");
  await expect(runCard).toContainText(`v1 · ${shortScriptsHash}`);
  await shot(target, testInfo, "runs");

  await window.getByTestId("menu-blueprints").click();
  await byPrefix(window, "blueprint-open-", "Scripts").click();
  await window.getByTestId("node-s2").click();
  await window.getByTestId(controlTestIds.delete).click();
  await saveNow(window);
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();

  const runId = (await runCard.getAttribute("data-testid"))?.slice("run-card-".length) ?? "";
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveAttribute(
    "data-status",
    "done",
  );
  await expect(window.getByTestId("node-s2")).toBeVisible();
  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId("inspector-node-s2")).toHaveAttribute("data-status", "done");
  await expect(window.getByTestId(controlTestIds.save)).toHaveCount(0);

  await window.getByTestId(pageTestIds.runAgain).click();
  await window.getByTestId(pageTestIds.runBack).click();
  await expect(byPrefix(window, "run-result-")).toHaveText(["done", "done"], { timeout: 20_000 });

  await closeApp();
  const runs = dbRows<{ id: string; build_hash: string }>("SELECT id, build_hash FROM runs");
  const scriptsBuilds = dbRows<{ hash: string; version: number }>(
    "SELECT hash, version FROM builds JOIN flows ON flows.id = builds.flow_id WHERE flows.name = 'Scripts'",
  );
  expect(scriptsBuilds.map((build) => build.version)).toEqual([1]);
  const [scriptsBuild] = scriptsBuilds;
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map((run) => run.id)).size).toBe(2);
  expect(runs.map((run) => run.build_hash)).toEqual([scriptsBuild?.hash, scriptsBuild?.hash]);
  expect(scriptsBuild?.hash.startsWith(shortScriptsHash ?? "missing")).toBe(true);
});

test("Build & run records a build in Builds and reuses it while the version is unchanged", async () => {
  seedFlow(home, twoScripts(), folder);
  const { window } = await launch();

  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveAttribute(
    "data-status",
    "done",
    { timeout: 20_000 },
  );
  await window.getByTestId(pageTestIds.runOpenBlueprint).click();
  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toBeVisible();

  await window.getByTestId(pageTestIds.runBack).click();
  await expect(byPrefix(window, "run-result-")).toHaveText(["done", "done"], { timeout: 20_000 });
  await window.getByTestId("menu-builds").click();
  await expect(byPrefix(window, "build-card-")).toHaveCount(1);
  await expect(byPrefix(window, "build-card-")).toContainText("Untitled v1");

  await closeApp();
  const builds = dbRows<{ hash: string; version: number }>("SELECT hash, version FROM builds");
  expect(builds).toEqual([{ hash: expect.any(String), version: 1 }]);
  expect(dbRows<{ build_hash: string }>("SELECT build_hash FROM runs")).toEqual([
    { build_hash: builds[0]?.hash },
    { build_hash: builds[0]?.hash },
  ]);
});

test("Doctor shows an installed connector and a missing one with its fix, and no secret", async () => {
  const testInfo = test.info();
  seedBlueprint(home, "Notifier", withConnectors(["slack", "linear"]), folder);
  const target = await launch();
  const { window } = target;

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-doctor").click();

  const slack = window.getByTestId(pageTestIds.doctorNeeded("slack"));
  const linear = window.getByTestId(pageTestIds.doctorNeeded("linear"));
  await expect(slack).toHaveAttribute("data-status", "ok");
  await expect(slack).toContainText("Installed");
  await expect(slack).toContainText("SLACK_TOKEN: set");
  await expect(linear).toHaveAttribute("data-status", "missing");
  await expect(linear).toContainText("Not installed");
  await expect(window.getByTestId(pageTestIds.doctorFix("linear"))).toHaveText(
    "Add it for your user with claude mcp add --scope user linear …, then build again.",
  );
  await expect(window.getByTestId(pageTestIds.doctorFix("linear")).locator("code")).toHaveText(
    "claude mcp add --scope user linear …",
  );
  await expect(window.getByTestId(pageTestIds.doctorInstalled("slack"))).toBeVisible();
  await expect(window.locator('[data-testid^="doctor-installed-"]')).toHaveCount(1);
  await expect(window.locator("body")).not.toContainText(secret);
  await shot(target, testInfo, "doctor");
});

test("Escape in the blueprint's name field keeps its old name", async () => {
  seedBlueprint(home, "Alpha", flow([prompt("p1")], []), folder);
  const { window } = await launch();
  const title = window.getByTestId(controlTestIds.title);
  await expect(title).toHaveValue("Alpha");

  await title.fill("Zeta");
  await title.press("Escape");

  await expect(title).toHaveValue("Alpha");
  await window.getByTestId(controlTestIds.back).click();
  await expect(byPrefix(window, "blueprint-open-")).toHaveText(["Alpha"]);
  await closeApp();
  expect(dbRows<{ name: string }>("SELECT name FROM flows")).toEqual([{ name: "Alpha" }]);
});

test("A run left running by an earlier session shows as interrupted, never live", async () => {
  const alpha = seedBlueprint(home, "Alpha", flow([prompt("p1")], []), folder);
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  let stale: string;
  try {
    const runs = new SqliteStore({ db });
    runs.recordBuild({ hash: "stalehash", dir: "/nowhere", source: alpha, files: [], nodes: [] });
    stale = runs.createRun({
      buildDir: "/nowhere",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run-gone", cwd: folder, claudeSessionId: "gone" },
      buildHash: "stalehash",
    }).id;
  } finally {
    db.close();
  }
  const { window } = await launch();

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await expect(window.getByTestId(pageTestIds.runResult(stale))).toHaveText("interrupted");
  await expect(window.getByTestId(pageTestIds.runCard(stale))).toContainText("—");
  await expect(window.getByRole("button", { name: "Runs", exact: true })).toBeVisible();

  await window.getByTestId(pageTestIds.runOpen(stale)).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("interrupted");
  await expect(window.getByTestId("inspector-session")).toHaveAttribute(
    "data-status",
    "interrupted",
  );
  await expect(window.getByTestId("run-status")).toHaveText("Idle");

  await closeApp();
  expect(dbRows<{ status: string }>("SELECT status FROM runs")).toEqual([{ status: "running" }]);
});

test("The status bar takes you from the editor to the live run that needs you", async () => {
  seedFlow(
    home,
    flow(
      [
        script("s1", { settings: { command: "echo", args: ["one"] } }),
        gate("g1"),
        script("s2", { settings: { command: "echo", args: ["two"] } }),
      ],
      [thenWire("s1", "g1"), thenWire("g1", "s2")],
    ),
    folder,
  );
  const { window } = await launch();

  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });
  await window.getByTestId(pageTestIds.runBack).click();
  await expect(window.getByRole("button", { name: /^Runs\s?, 1 running$/ })).toBeVisible();
  await byPrefix(window, "run-open-").click();
  await window.getByTestId(pageTestIds.runOpenBlueprint).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
  await expect(window.getByTestId("wait-panel")).toHaveCount(0);

  const status = window.getByRole("button", { name: /^Needs you/ });
  await expect(status).toHaveAttribute("data-testid", "run-status");
  await status.click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("needs you");
  await window.getByTestId("wait-approve").click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("inspector-node-s2")).toHaveAttribute("data-status", "done");
  await expect(window.getByRole("button", { name: /^Done/ })).toHaveCount(0);
  await expect(window.getByTestId("run-status")).toHaveText(/^Done/);
});
