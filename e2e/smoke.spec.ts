import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const realDb = join(homedir(), ".flowdeck", "flowdeck.db");
const realDbMtime = () => (existsSync(realDb) ? statSync(realDb).mtimeMs : undefined);

let home: string;
let logDir: string;
let launched: LaunchedApp | undefined;
let window: Page;
let realDbBefore: number | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-e2e-home-"));
  logDir = await mkdtemp(join(tmpdir(), "fd-e2e-log-"));
  realDbBefore = realDbMtime();
  launched = await launchApp({ home, logPath: join(logDir, "app.log") });
  window = launched.window;
});

test.afterEach(async () => {
  await launched?.close();
  await rm(home, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

test("opens a window titled Flowdeck", async () => {
  await expect.poll(() => window.title()).toBe("Flowdeck");
});

test("shows the package version answered by the engine", async () => {
  await expect(window.getByTestId("app-version")).toHaveText(packageVersion);
});

test("gives the renderer no Node", async () => {
  expect(await window.evaluate(() => [typeof require, typeof process])).toEqual([
    "undefined",
    "undefined",
  ]);
});

test("opens the SQLite store in the temporary FLOWDECK_HOME and nowhere else", async () => {
  await expect(window.getByTestId("store-status")).toHaveText("ready");
  expect(existsSync(join(home, "flowdeck.db"))).toBe(true);
  expect(realDbMtime()).toBe(realDbBefore);
});
