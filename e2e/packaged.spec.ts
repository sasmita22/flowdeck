import { listPackage } from "@electron/asar";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import {
  blueprintTerminalTestId,
  controlTestIds,
  pageTestIds,
} from "../src/app/renderer/test-ids.js";
import {
  flow,
  onMainFlow,
  output,
  prompt,
  script,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo } from "../test/fixtures/tmp-repo.js";
import { hideWindow, testDisplayFlags } from "../scripts/window-mode.js";
import { buildAndRun, buildOnCanvas } from "./build-run.js";
import { fakeClaudeRan, launchWithFakeClaude } from "./fake-claude.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultAppPath = join(repoRoot, "out", "Flowdeck-darwin-arm64", "Flowdeck.app");
const appPath = process.env["FLOWDECK_PACKAGED_APP"] ?? defaultAppPath;
const makeDir = join(repoRoot, "out", "make");
const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const connectDeadlineMs = 30_000;
const outputTailChars = 2_000;

const executable = (app: string) => join(app, "Contents", "MacOS", "Flowdeck");
const appAsar = (app: string) => join(app, "Contents", "Resources", "app.asar");
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

const toolDir = (tool: string): string => {
  const dir = (process.env["PATH"] ?? "")
    .split(":")
    .find((entry) => entry !== "" && existsSync(join(entry, tool)));
  if (dir === undefined) throw new Error(`No ${tool} on the test's PATH`);
  return dir;
};

const loginShell = async (home: string): Promise<string> => {
  const shell = join(home, "login-shell");
  const loginPath = [
    join(home, "fake-claude-bin"),
    dirname(process.execPath),
    toolDir("tmux"),
  ].join(":");
  await writeFile(
    shell,
    `#!/bin/sh\nPATH="${loginPath}:$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`,
  );
  await chmod(shell, 0o755);
  return shell;
};

const startCopy = async (home: string, env: Readonly<Record<string, string>> = {}) => {
  const shell = await loginShell(home);
  const copyDir = await mkdtemp(join(tmpdir(), "fd-packaged-app-"));
  tempDirs.push(copyDir);
  const copy = join(copyDir, "Flowdeck.app");
  await run("ditto", [appPath, copy]);

  const port = await freePort();
  let output = "";
  const launched = spawn(
    executable(copy),
    [...testDisplayFlags, `--remote-debugging-port=${port}`],
    {
      env: {
        ...(hideWindow(process.env) && { FLOWDECK_HIDE_WINDOW: "1" }),
        HOME: home,
        SHELL: shell,
        PATH: env["PATH"] ?? minimalPath,
        ...(env["FAKE_CLAUDE_LOG"] !== undefined && { FAKE_CLAUDE_LOG: env["FAKE_CLAUDE_LOG"] }),
        FLOWDECK_HOME: home,
      },
    },
  );
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
  return { launch, window };
};

const launchCopy = async (home: string, env: Readonly<Record<string, string>> = {}) => {
  let started: { launch: Launch; window: Page } | undefined;
  const { window } = await launchWithFakeClaude({
    home,
    env,
    logPath: test.info().outputPath("app.log"),
    basePath: minimalPath,
    launch: async (appHome, _colorScheme, env) => {
      const copy = await startCopy(appHome, env);
      started = copy;
      return {
        process: () => copy.launch.child,
        firstWindow: () => Promise.resolve(copy.window),
        evaluate: () => Promise.reject(new Error("a packaged copy has no main-process access")),
      };
    },
  });
  if (started === undefined) throw new Error("the packaged copy did not start");
  const { launch } = started;
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
  const repo = await createTmpRepo({ commit: true });
  tempDirs.push(repo.path);
  seedFlow(
    home,
    flow(
      [trigger("t"), script("s", { settings: { command: "echo", args: ["ok"] } }), output("stop")],
      [thenWire("t", "s"), thenWire("s", "stop")],
    ),
    repo.path,
  );

  const { window, quit: quitCopy } = await launchCopy(home);
  await expect(window.getByTestId("canvas-build")).toBeVisible();
  await buildAndRun(window, home, "packaged");
  expect(existsSync(fakeClaudeRan(home))).toBe(true);

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

test("the kit ships inside app.asar", () => {
  const skills = readdirSync(join(repoRoot, "kit", "skills"));
  expect(skills).toHaveLength(10);
  const listed = listPackage(appAsar(appPath), { isPack: false });
  expect(listed).toEqual(
    expect.arrayContaining([
      "/.vite/build/kit/.claude-plugin/plugin.json",
      ...skills.map((skill) => `/.vite/build/kit/skills/${skill}/SKILL.md`),
    ]),
  );
});

test("a copy copies the kit out under its home and its build session loads that kit", async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), "fd-packaged-home-"));
  tempDirs.push(home);
  const repo = await createTmpRepo({ commit: true });
  tempDirs.push(repo.path);
  seedFlow(
    home,
    onMainFlow([script("s", { settings: { command: "echo", args: ["ok"] } })], []),
    repo.path,
  );
  const argvLog = join(home, "argv.log");

  const { window } = await launchCopy(home, { FAKE_CLAUDE_LOG: argvLog });
  const kitRoot = join(home, "kit");
  const versions = () =>
    existsSync(kitRoot) ? readdirSync(kitRoot).filter((name) => /^[0-9a-f]{12}$/.test(name)) : [];
  await expect.poll(versions, { timeout: 20_000 }).toHaveLength(1);
  const [version] = versions();

  await expect(window.getByTestId("canvas-build")).toBeVisible();
  await buildOnCanvas(window, home, "kit-check");
  expect(existsSync(fakeClaudeRan(home))).toBe(true);

  const launches = readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string[]);
  const pluginDirs = launches.flatMap((argv) =>
    argv.flatMap((arg, at) => (arg === "--plugin-dir" ? [argv[at + 1]] : [])),
  );
  expect(pluginDirs).toContain(join(kitRoot, version ?? ""));
});

test("the MCP server and blueprint kit ship inside app.asar", () => {
  const listed = listPackage(appAsar(appPath), { isPack: false });
  expect(listed).toEqual(
    expect.arrayContaining([
      "/.vite/build/flowdeck-mcp.cjs",
      "/.vite/build/kit-blueprint/skills/blueprint/SKILL.md",
    ]),
  );
});

test("the packaged app copies the MCP server out on start and the blueprint session uses it", async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), "fd-packaged-home-"));
  tempDirs.push(home);
  const { flowId } = seedBlueprint(home, "mcp-check", flow([prompt("p1")], []));
  const bpSession = `fd-bp-${flowId}`;
  const copiedScript = join(home, "mcp", "flowdeck-mcp.cjs");

  try {
    const { window } = await launchCopy(home);
    await expect.poll(() => existsSync(copiedScript), { timeout: 20_000 }).toBe(true);

    const back = window
      .getByTestId(controlTestIds.back)
      .or(window.getByTestId(pageTestIds.runBack));
    if (await back.isVisible()) await back.click();
    await window.getByTestId("menu-blueprints").click();
    await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
    await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
    await window.getByTestId(controlTestIds.blueprintTerminalToggle).click();
    await expect(window.getByTestId(blueprintTerminalTestId)).toContainText(
      `Fake Claude in ${bpSession}`,
      { timeout: 20_000 },
    );

    const argvs = readFileSync(fakeClaudeRan(home), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
    const mcpConfigs = argvs.flatMap((argv) =>
      argv.flatMap((arg, at) => (arg === "--mcp-config" ? [argv[at + 1]] : [])),
    );
    const pluginDirs = argvs.flatMap((argv) =>
      argv.flatMap((arg, at) => (arg === "--plugin-dir" ? [argv[at + 1] ?? ""] : [])),
    );
    expect(pluginDirs).toHaveLength(1);
    expect(existsSync(join(pluginDirs[0] ?? "", "skills", "blueprint", "SKILL.md"))).toBe(true);
    const mcpConfig = join(home, "bp-sessions", flowId, "mcp.json");
    expect(mcpConfigs).toEqual([mcpConfig]);
    const config = JSON.parse(readFileSync(mcpConfig, "utf8")) as {
      mcpServers: Record<string, { args?: string[] }>;
    };
    expect(config.mcpServers["flowdeck"]?.args).toEqual([copiedScript]);
  } finally {
    await promisify(execFile)("tmux", ["-L", bpSession, "kill-server"]).catch(() => undefined);
  }
});
