import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { flow, script, thenWire, trigger } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo } from "../test/fixtures/tmp-repo.js";
import { hideWindow, testScaleFactor } from "../scripts/window-mode.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultAppPath = join(repoRoot, "out", "Flowdeck-darwin-arm64", "Flowdeck.app");
const appPath = process.env["FLOWDECK_PACKAGED_APP"] ?? defaultAppPath;
const makeDir = join(repoRoot, "out", "make");
const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const connectDeadlineMs = 30_000;
const outputTailChars = 2_000;

const executable = (app: string) => join(app, "Contents", "MacOS", "Flowdeck");
const unpackedModules = (app: string) =>
  join(app, "Contents", "Resources", "app.asar.unpacked", "node_modules");

const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

const realDb = join(homedir(), ".flowdeck", "flowdeck.db");
const realDbMtime = () => (existsSync(realDb) ? statSync(realDb).mtimeMs : undefined);

const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }) : [];

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (address === null || typeof address === "string") throw new Error("No free port");
  return address.port;
};

const run = async (command: string, args: string[]) => {
  const child = spawn(command, args, { stdio: "inherit" });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${String(code)}`);
};

let tempDirs: string[] = [];
type Launch = { child: ChildProcess; browser?: Browser | undefined };

let launches: Launch[] = [];

test.beforeAll(() => {
  if (!existsSync(executable(appPath))) {
    throw new Error(`No packaged app at ${appPath}. Run npm run make first.`);
  }
});

const quit = async ({ child, browser }: Launch) => {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
};

test.afterAll(async () => {
  for (const launch of launches) await quit(launch);
  launches = [];
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

const launchCopy = async (home: string) => {
  const copyDir = await mkdtemp(join(tmpdir(), "fd-packaged-app-"));
  tempDirs.push(copyDir);
  const copy = join(copyDir, "Flowdeck.app");
  await run("ditto", [appPath, copy]);

  const port = await freePort();
  let output = "";
  const launched = spawn(executable(copy), [testScaleFactor, `--remote-debugging-port=${port}`], {
    env: {
      ...(hideWindow(process.env) && { FLOWDECK_HIDE_WINDOW: "1" }),
      HOME: homedir(),
      PATH: minimalPath,
      FLOWDECK_HOME: home,
    },
  });
  const launch: Launch = { child: launched };
  launches.push(launch);
  launched.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  launched.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const failure = (reason: string) =>
    new Error(`${reason}\n--- app output tail ---\n${output.slice(-outputTailChars)}`);
  const deadline = Date.now() + connectDeadlineMs;
  while (launch.browser === undefined) {
    if (launched.exitCode !== null || launched.signalCode !== null) {
      throw failure(
        `Packaged app exited before CDP attach (code ${String(launched.exitCode)}, signal ${String(launched.signalCode)})`,
      );
    }
    if (Date.now() > deadline) {
      throw failure(`No CDP endpoint on port ${port} within ${connectDeadlineMs} ms`);
    }
    launch.browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`)
      .catch(() => undefined);
    if (launch.browser === undefined) await sleep(250);
  }

  const context = launch.browser.contexts()[0];
  if (context === undefined) throw failure("CDP browser has no context");
  const window: Page = context.pages()[0] ?? (await context.waitForEvent("page"));
  return { window, quit: () => quit(launch) };
};

test("make leaves a dmg and a zip", () => {
  const files = filesUnder(makeDir);
  expect(
    files.filter((file) => file.endsWith(".dmg")),
    `dmg under ${makeDir}`,
  ).not.toEqual([]);
  expect(
    files.filter((file) => file.endsWith(".zip")),
    `zip under ${makeDir}`,
  ).not.toEqual([]);
});

test("the bundle is Flowdeck.app with a Flowdeck executable", () => {
  // The default APFS volume is case-insensitive, so only directory listings show the real case.
  expect(readdirSync(dirname(appPath))).toContain("Flowdeck.app");
  expect(readdirSync(join(appPath, "Contents", "MacOS"))).toContain("Flowdeck");
});

test("natives ship unpacked and spawn-helper is executable", () => {
  const modules = unpackedModules(appPath);
  const ptyAddon = join(modules, "node-pty", "build", "Release", "pty.node");
  const spawnHelper = join(modules, "node-pty", "build", "Release", "spawn-helper");
  const sqliteAddon = join(modules, "better-sqlite3", "prebuilds", "darwin-arm64.node");
  expect(existsSync(ptyAddon), ptyAddon).toBe(true);
  expect(existsSync(spawnHelper), spawnHelper).toBe(true);
  expect(statSync(spawnHelper).mode & 0o111, `${spawnHelper} execute bits`).not.toBe(0);
  expect(existsSync(sqliteAddon), sqliteAddon).toBe(true);
});

test("a copy outside the repo opens the window and the engine opens SQLite", async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), "fd-packaged-home-"));
  tempDirs.push(home);

  const realDbBefore = realDbMtime();
  const { window } = await launchCopy(home);

  await expect.poll(() => window.title()).toBe("Flowdeck");
  await expect(window.getByTestId("app-version")).toHaveText(packageVersion);
  expect(await window.evaluate(() => [typeof require, typeof process])).toEqual([
    "undefined",
    "undefined",
  ]);
  await expect(window.getByTestId("store-status")).toHaveText("ready");
  expect(existsSync(join(home, "flowdeck.db"))).toBe(true);
  expect(realDbMtime()).toBe(realDbBefore);
});

test("a copy launched with the minimal PATH runs a script-only flow to done", async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), "fd-packaged-home-"));
  tempDirs.push(home);
  const repo = await createTmpRepo();
  tempDirs.push(repo.path);
  seedFlow(
    home,
    flow(
      [trigger("t"), script("s", { settings: { command: "echo", args: ["ok"] } })],
      [thenWire("t", "s")],
    ),
    repo.path,
  );

  const { window, quit: quitCopy } = await launchCopy(home);
  await expect(window.getByTestId("canvas-run")).toBeVisible();
  await window.getByTestId("canvas-run").click();

  const runError = window.getByTestId("run-error");
  const scriptStatus = window.getByTestId("node-status-s");
  await expect
    .poll(
      async () =>
        (await runError.count()) > 0
          ? await runError.textContent()
          : await scriptStatus.getAttribute("data-status"),
      { timeout: 30_000 },
    )
    .toBe("done");
  await quitCopy();

  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    expect(db.prepare("SELECT status FROM runs").all()).toEqual([{ status: "done" }]);
  } finally {
    db.close();
  }
});
