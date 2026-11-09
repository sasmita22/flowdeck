import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  buildConfigTestIds,
  buildDialogTestIds,
  controlTestIds,
  dialogTestIds,
  pageTestIds,
} from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { flow, gate, prompt, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { waitForBuilt } from "./build-run.js";

const run = promisify(execFile);

let home: string;
let repo: TmpRepo;
let bin: string;
let launched: LaunchedApp | undefined;

const fakeClaude = `
const { appendFileSync } = require("node:fs");
const { connect } = require("node:net");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), argv }) + "\\n");
const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? "";
const sock = process.env.FLOWDECK_SOCK ?? "";
const session = sock.slice(sock.lastIndexOf("/") + 1).replace(/\\.sock$/, "");
let typed = "";
const draw = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[HFake Claude in " + session + "\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n",
  );
const stop = () => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: "ok" }) + "\\n");
  });
  socket.on("error", () => undefined);
};
process.stdout.on("resize", draw);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") {
      if (typed !== "") setTimeout(stop, 50);
      typed = "";
    } else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const argvLog = () => join(bin, "argv.log");

const blueprint = (): Flow => {
  const laidOut = flow(
    [
      prompt("p1", { settings: { instructions: "Work on {{ticket}}." } }),
      gate("g1", { settings: { shown: "Check the plan", skippable: true } }),
      script("s2", { settings: { command: "sh", args: ["-c", "echo two"] } }),
    ].map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
    [thenWire("p1", "g1"), thenWire("g1", "s2")],
  );
  return {
    ...laidOut,
    session: {
      ...laidOut.session,
      buildConfig: { variables: [{ name: "ticket", kind: "text" }] },
    },
  };
};

const launch = async () => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    ownBin: bin,
    env: {
      FAKE_CLAUDE_LOG: argvLog(),
      FLOWDECK_CLAUDE_CONFIG: join(home, "claude.json"),
    },
  });
  await expect(launched.window.getByTestId(controlTestIds.build)).toBeVisible();
  return launched.window;
};

const rows = <T>(sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const buildNamed = (name: string) =>
  rows<{ id: string }>("SELECT id FROM builds WHERE name = ? AND deleted_at IS NULL", name);

const runOf = (buildId: string) =>
  rows<{ id: string; status: string; tmux_name: string }>(
    `SELECT runs.id, runs.status, run_sessions.tmux_name
       FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
      WHERE runs.build_id = ?`,
    buildId,
  );

const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const killOwnTmux = async () => {
  let names: { tmux_name: string }[];
  try {
    names = rows("SELECT tmux_name FROM run_sessions");
  } catch {
    return;
  }
  for (const { tmux_name: name } of names) {
    if (!/^fd-run-[0-9a-f]{8}$/.test(name)) continue;
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
    await rm(join(tmuxSockets, name), { force: true });
  }
};

const openBuildDialog = async (window: Page, flowId: string) => {
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintBuild(flowId)).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
};

const build = async (window: Page, flowId: string, name: string, ticket: string) => {
  await openBuildDialog(window, flowId);
  await window.getByTestId(buildDialogTestIds.name).fill(name);
  await window.getByTestId(buildDialogTestIds.variable("ticket")).fill(ticket);
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  await waitForBuilt(window, home, name);
  const [built] = buildNamed(name);
  if (built === undefined) throw new Error(`no build named ${name} was recorded`);
  return built.id;
};

const toMenu = async (window: Page) => {
  const runBack = window.getByTestId(pageTestIds.runBack);
  await expect(window.getByTestId("menu-builds").or(runBack)).toBeVisible();
  if (await runBack.isVisible()) await runBack.click();
};

const toBuilds = async (window: Page) => {
  await toMenu(window);
  await window.getByTestId("menu-builds").click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Builds");
};

const runFromCard = async (window: Page, buildId: string) => {
  await toBuilds(window);
  await window.getByTestId(pageTestIds.buildRun(buildId)).click();
  await expect(window.getByTestId(dialogTestIds.dialog)).toBeVisible();
  await window.getByTestId(dialogTestIds.start).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("needs you", {
    timeout: 30_000,
  });
  const [started] = runOf(buildId);
  if (started === undefined) throw new Error(`build ${buildId} recorded no run`);
  return started;
};

test.beforeEach(async () => {
  launched = undefined;
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-builds-")));
  repo = await createTmpRepo({ commit: true });
  bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(home, "claude.json"), JSON.stringify({ mcpServers: {} }));
});

test.afterEach(async () => {
  try {
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    await killOwnTmux();
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("The canvas offers Build and no Run, and Run on a build card asks only for auto mode", async () => {
  const { flowId } = seedBlueprint(home, "Fixer", blueprint(), repo.path);
  const window = await launch();

  const titleActions = window.locator(".fd-title-actions");
  await expect(titleActions.getByTestId(controlTestIds.build)).toBeVisible();
  await expect(titleActions.getByRole("button", { name: /run/i })).toHaveCount(0);
  await window.getByTestId(controlTestIds.build).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
  await window.getByTestId(buildDialogTestIds.cancel).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();

  const buildId = await build(window, flowId, "fix-a", "FD-1");
  await toBuilds(window);
  await window.getByTestId(pageTestIds.buildRun(buildId)).click();

  const dialog = window.getByTestId(dialogTestIds.dialog);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId(dialogTestIds.auto)).toBeVisible();
  await expect(dialog.locator("input, select, textarea")).toHaveCount(1);
});

test("Build asks for a name, repo, base and every value, and refuses a name already taken", async () => {
  const { flowId } = seedBlueprint(home, "Fixer", blueprint(), repo.path);
  const window = await launch();

  await openBuildDialog(window, flowId);
  await expect(window.getByTestId(buildDialogTestIds.name)).toHaveValue("");
  await expect(window.getByTestId(buildDialogTestIds.repo)).toHaveValue(repo.path);
  await expect(window.getByTestId(buildDialogTestIds.base)).toHaveValue("main");
  await expect(window.getByTestId(buildDialogTestIds.variable("ticket"))).toHaveValue("");
  const confirm = window.getByTestId(buildDialogTestIds.confirm);
  await expect(confirm).toBeDisabled();
  await window.getByTestId(buildDialogTestIds.name).fill("fix-a");
  await expect(confirm).toBeDisabled();
  await window.getByTestId(buildDialogTestIds.variable("ticket")).fill("FD-1");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  await waitForBuilt(window, home, "fix-a");
  const [built] = buildNamed("fix-a");
  if (built === undefined) throw new Error("no build named fix-a was recorded");
  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildCard(built.id))).toContainText("fix-a");

  await openBuildDialog(window, flowId);
  await window.getByTestId(buildDialogTestIds.name).fill("fix-a");
  await window.getByTestId(buildDialogTestIds.variable("ticket")).fill("FD-2");
  await window.getByTestId(buildDialogTestIds.confirm).click();

  await expect(window.getByTestId(buildDialogTestIds.error)).toContainText(
    "A build named fix-a already exists.",
  );
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
  expect(buildNamed("fix-a")).toHaveLength(1);
});

test("A running build refuses another run, while a second build runs beside it in its own terminal", async () => {
  const { flowId } = seedBlueprint(home, "Fixer", blueprint(), repo.path);
  const window = await launch();
  const first = await build(window, flowId, "fix-a", "FD-1");
  const second = await build(window, flowId, "fix-b", "FD-2");

  const firstRun = await runFromCard(window, first);
  await toBuilds(window);
  await expect(window.getByTestId(pageTestIds.buildRun(first))).toBeDisabled();
  await expect(window.getByTestId(pageTestIds.buildRun(second))).toBeEnabled();

  const secondRun = await runFromCard(window, second);
  expect(runOf(first).map((row) => row.status)).toEqual(["running"]);
  expect(runOf(second).map((row) => row.status)).toEqual(["running"]);
  expect(firstRun.tmux_name).not.toBe(secondRun.tmux_name);

  for (const started of [firstRun, secondRun]) {
    await toMenu(window);
    await window.getByTestId("menu-runs").click();
    await window.getByTestId(pageTestIds.runOpen(started.id)).click();
    await window.getByTestId("run-tab-terminal").click();
    await expect(window.getByTestId("terminal-view")).toContainText(
      `Fake Claude in ${started.tmux_name}`,
      { timeout: 20_000 },
    );
  }

  const launches = (await readFile(argvLog(), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string });
  expect(launches.map(({ cwd }) => cwd).sort()).toEqual(
    [first, second].map((id) => join(home, "workspaces", id, basename(repo.path))).sort(),
  );
});

const stubFolderPicker = async (picked: string) => {
  await launched?.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as unknown as typeof dialog.showOpenDialog;
  }, picked);
};

test("The Build dialog picks repo, branch and build model with the settings' fields, and leaves the blueprint unchanged", async () => {
  await run("git", ["-C", repo.path, "branch", "dev"]);
  const other = await createTmpRepo({ commit: true });
  try {
    const { flowId } = seedBlueprint(home, "Fixer", blueprint());
    const window = await launch();
    await openBuildDialog(window, flowId);
    const repoField = window.getByTestId(buildDialogTestIds.repo);
    const basePick = window.getByTestId(buildDialogTestIds.base);
    const modelPick = window.getByTestId(controlTestIds.buildModel);

    await expect(repoField).toHaveValue("");
    await expect(window.getByTestId(buildDialogTestIds.repoBrowse)).toHaveAccessibleName(
      "Browse for a folder",
    );
    await expect(basePick).toBeDisabled();
    await expect(basePick.locator("option")).toHaveText(["Choose a repository first"]);
    expect(await modelPick.evaluate((element) => element.tagName)).toBe("SELECT");
    await expect(modelPick.locator("option").first()).toHaveText("The session's default");
    await expect(modelPick).toHaveValue("");

    await stubFolderPicker(other.path);
    await window.getByTestId(buildDialogTestIds.repoBrowse).click();
    await expect(repoField).toHaveValue(other.path);
    await expect(basePick).toBeEnabled();
    await expect(basePick.locator("option")).toHaveText(["main"]);
    await expect(basePick).toHaveValue("main");

    await repoField.fill(repo.path);
    await repoField.press("Enter");
    await expect(basePick.locator("option")).toHaveText(["dev", "main"]);
    await expect(basePick).toHaveValue("main");
    await basePick.selectOption("dev");
    await modelPick.selectOption("haiku");
    await window.getByTestId(buildDialogTestIds.name).fill("fix-dialog");
    await window.getByTestId(buildDialogTestIds.variable("ticket")).fill("FD-1");
    await window.getByTestId(buildDialogTestIds.confirm).click();
    await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
    await waitForBuilt(window, home, "fix-dialog");

    expect(
      rows<{ repo: string; base: string }>(
        "SELECT repo, base FROM builds WHERE name = ?",
        "fix-dialog",
      ),
    ).toEqual([{ repo: repo.path, base: "dev" }]);
    const [pending] = rows<{ origin_json: string }>(
      "SELECT origin_json FROM pending_builds WHERE name = ?",
      "fix-dialog",
    );
    expect(JSON.parse(pending?.origin_json ?? "{}")).toMatchObject({
      request: { repo: repo.path, base: "dev", buildModel: "haiku" },
    });
    const sessions = rows<{ session: string }>(
      "SELECT session FROM flow_versions WHERE flow_id = ?",
      flowId,
    ).map(({ session }) => JSON.parse(session) as { buildConfig: object; budget?: number });
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.buildConfig).not.toHaveProperty("repo");
      expect(session.buildConfig).not.toHaveProperty("base");
      expect(session).not.toHaveProperty("budget");
    }

    await toMenu(window);
    await window.getByTestId("menu-blueprints").click();
    await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
    await window.getByTestId(controlTestIds.sessionSettings).click();
    await expect(window.getByTestId(buildConfigTestIds.repo)).toHaveValue("");
    await expect(window.getByTestId(buildConfigTestIds.base)).toBeDisabled();
  } finally {
    await other.cleanup();
  }
});
