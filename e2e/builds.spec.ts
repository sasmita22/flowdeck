import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildDialogTestIds,
  containerTestIds,
  controlTestIds,
  dialogTestIds,
  pageTestIds,
} from "../src/app/renderer/test-ids.js";
import { modelChoices } from "../src/core/flow/choices.js";
import type { Flow, FlowContainer } from "../src/core/flow/schema.js";
import {
  agent,
  gate,
  onWorkspaceMainFlow,
  thenWire,
  withSession,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { waitForBuilt } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";
import { workspaceFolder } from "../src/core/run/workspace.js";

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
const send = (event) => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ session_id: sessionId, ...event }) + "\\n");
  });
  socket.on("error", () => undefined);
};
const stop = () => send({ hook_event_name: "Stop", last_assistant_message: "ok" });
const dispatched = /subagent_type "([^"]+)" and the prompt "NODE ([^\\\\"]+)/;
const turn = (text) => {
  const match = dispatched.exec(text);
  if (match === null) return setTimeout(stop, 50);
  const [, agentType, nodeId] = match;
  setTimeout(() => {
    send({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "fake-" + nodeId + "-" + Date.now(),
      tool_input: { subagent_type: agentType, prompt: "NODE " + nodeId + "\\nGo" },
      tool_response: { agentType, status: "completed" },
    });
    setTimeout(stop, 100);
  }, 50);
};
process.stdout.on("resize", draw);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") {
      if (typed !== "") turn(typed);
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
  const built = onWorkspaceMainFlow(
    [
      agent("p1", { settings: { instructions: "Work on {{ticket}}." } }),
      gate("g1", { settings: { shown: "Check the plan", skippable: true } }),
      agent("s2"),
    ],
    [thenWire("p1", "g1"), thenWire("g1", "s2")],
  );
  return withSession(
    {
      ...built,
      nodes: built.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
    },
    { repo: "", branch: "" },
  );
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
      WHERE runs.build_id = ? AND run_sessions.parent IS NULL`,
    buildId,
  );

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
    await killRunSessions(home);
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
    .map((line) => JSON.parse(line) as { cwd: string } | string[])
    .flatMap((launch) => (Array.isArray(launch) ? [] : [launch.cwd]));
  expect(launches.sort()).toEqual(
    [first, second].map((id) => workspaceFolder(join(home, "workspaces", id))).sort(),
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
    await expect(modelPick.locator("option")).toHaveText(modelChoices.map(({ label }) => label));
    await expect(modelPick).toHaveValue("sonnet");

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
    const sessions = rows<{ containers: string }>(
      "SELECT containers FROM flow_versions WHERE flow_id = ?",
      flowId,
    ).flatMap(({ containers }) =>
      (JSON.parse(containers) as FlowContainer[]).filter(({ kind }) => kind === "session"),
    );
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session).toMatchObject({ repo: "", branch: "" });
    }

    await toMenu(window);
    await window.getByTestId("menu-blueprints").click();
    await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
    await window
      .getByTestId(containerTestIds.frame("session-1"))
      .click({ position: { x: 6, y: 6 } });
    await expect(window.getByTestId(containerTestIds.field("session-1", "repo"))).toHaveValue("");
    await expect(window.getByTestId(containerTestIds.field("session-1", "branch"))).toBeDisabled();
  } finally {
    await other.cleanup();
  }
});

test("The Build dialog recommends a new branch that follows the build name until edited, and lists existing branches with the checked-out one disabled", async () => {
  await run("git", ["-C", repo.path, "branch", "flowdeck/fix-a"]);
  await run("git", ["-C", repo.path, "branch", "feat-y"]);
  const longBranch = "feature/some-long-branch-name-that-is-wider-than-the-dialog-and-keeps-going";
  await run("git", ["-C", repo.path, "branch", longBranch]);
  const longPath = join(
    home,
    "worktrees",
    "a-checkout-folder-whose-path-is-far-wider-than-the-dialog",
  );
  await run("git", ["-C", repo.path, "worktree", "add", "-b", "flowdeck/mt-custom", longPath]);
  const { flowId } = seedBlueprint(home, "Fixer", blueprint(), repo.path);
  const window = await launch();
  await openBuildDialog(window, flowId);
  const name = window.getByTestId(buildDialogTestIds.name);
  const branchName = window.getByTestId(buildDialogTestIds.branchName);

  await expect(window.getByTestId(buildDialogTestIds.branchNew)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await name.fill("fix-a");
  await expect(branchName).toHaveValue("flowdeck/fix-a-2");
  await name.fill("fix-b");
  await expect(branchName).toHaveValue("flowdeck/fix-b");
  await branchName.fill("mine/fix");
  await name.fill("fix-c");
  await expect(branchName).toHaveValue("mine/fix");

  await window.getByTestId(buildDialogTestIds.branchExisting).click();
  await expect(branchName).toBeHidden();
  const featY = window.getByTestId(buildDialogTestIds.existingBranch("feat-y"));
  const main = window.getByTestId(buildDialogTestIds.existingBranch("main"));
  await expect(featY).toBeEnabled();
  await expect(
    window.getByTestId(buildDialogTestIds.existingBranch("flowdeck/fix-a")),
  ).toBeEnabled();
  await expect(main).toBeDisabled();
  await expect(main).toContainText(`Checked out in ${repo.path}`);

  const custom = window.getByTestId(buildDialogTestIds.existingBranch("flowdeck/mt-custom"));
  await expect(custom).toContainText(`Checked out in ${longPath}`);
  await expect(window.getByTestId(buildDialogTestIds.existingBranch(longBranch))).toBeEnabled();
  const list = window.getByRole("group", { name: "Existing branch" });
  expect(await list.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const branchLabel = custom.getByText("flowdeck/mt-custom", { exact: true });
  const branchLines = await branchLabel.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length;
  });
  expect(branchLines).toBe(1);
});

test("A build on an existing branch shows that branch and no base on its page, and keeps the branch as not created", async () => {
  await run("git", ["-C", repo.path, "branch", "feat-y"]);
  const { flowId } = seedBlueprint(home, "Fixer", blueprint(), repo.path);
  const window = await launch();
  await openBuildDialog(window, flowId);
  await window.getByTestId(buildDialogTestIds.name).fill("fix-existing");
  await window.getByTestId(buildDialogTestIds.variable("ticket")).fill("FD-1");
  const existing = window.getByTestId(buildDialogTestIds.branchExisting);
  await expect(existing).toHaveAttribute("aria-pressed", "false");
  await existing.click();
  await expect(existing).toHaveAttribute("aria-pressed", "true");
  await window.getByTestId(buildDialogTestIds.existingBranch("feat-y")).click();
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();

  const facts = window.locator(".fd-facts");
  const fact = (label: string) =>
    facts
      .locator("div")
      .filter({ has: window.getByRole("term").getByText(label, { exact: true }) });
  await expect(fact("Branch").getByRole("definition")).toHaveText("feat-y", { timeout: 20_000 });
  await expect(fact("Base")).toHaveCount(0);

  await waitForBuilt(window, home, "fix-existing");
  expect(
    rows<{ branch: string; branch_created: number }>(
      "SELECT branch, branch_created FROM builds WHERE name = ?",
      "fix-existing",
    ),
  ).toEqual([{ branch: "feat-y", branch_created: 0 }]);
});
