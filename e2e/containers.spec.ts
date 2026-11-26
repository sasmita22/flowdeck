import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildDialogTestIds,
  containerTestIds,
  controlTestIds,
  pageTestIds,
  paletteTestId,
  readoutTestIds,
  type ContainerField,
} from "../src/app/renderer/test-ids.js";
import type { Flow, FlowContainer } from "../src/core/flow/schema.js";
import { sessionWorktree } from "../src/core/run/workspace.js";
import { sessionsWorkflow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { latestFlowId, launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";
import { buildOnCanvas, buildWorktreePaths, runFromDetail, runIdOf } from "./build-run.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { endSessionsOfHome } from "./own-sessions.js";

let home: string;
let launched: LaunchedApp | undefined;
let repo: TmpRepo | undefined;
let otherRepo: TmpRepo | undefined;

const git = promisify(execFile);

test.beforeEach(async () => {
  launched = undefined;
  repo = undefined;
  otherRepo = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-ct-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    try {
      await endSessionsOfHome(home);
      await rm(home, { recursive: true, force: true });
    } finally {
      await repo?.cleanup();
      await otherRepo?.cleanup();
    }
  }
});

const launch = async () => {
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched.window;
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

const readout = async (window: Page): Promise<Flow> =>
  JSON.parse((await window.getByTestId(readoutTestIds.flow).textContent()) ?? "") as Flow;

const selection = async (window: Page): Promise<string[]> =>
  JSON.parse((await window.getByTestId(readoutTestIds.selection).textContent()) ?? "") as string[];

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const frame = (window: Page, id: string) => window.getByTestId(containerTestIds.frame(id));

const field = (window: Page, id: string, name: ContainerField) =>
  window.getByTestId(containerTestIds.field(id, name));

const selectContainer = async (window: Page, id: string) => {
  await frame(window, id).click({ position: { x: 6, y: 6 } });
  await expect.poll(() => selection(window)).toEqual([id]);
};

const savedContainers = (): FlowContainer[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT containers FROM flow_versions ORDER BY rowid DESC LIMIT 1")
      .get() as { containers: string } | undefined;
    return row === undefined ? [] : (JSON.parse(row.containers) as FlowContainer[]);
  } finally {
    db.close();
  }
};

const settingsOf = (containers: readonly FlowContainer[]) =>
  containers.map(({ nodes, ...settings }) => ({ ...settings, members: nodes.length }));

const setSession = async (
  window: Page,
  id: string,
  values: { name: string; repo: string; branch: string; model: string },
) => {
  await selectContainer(window, id);
  const name = field(window, id, "name");
  await name.fill(values.name);
  await name.press("Enter");
  const repoField = field(window, id, "repo");
  await repoField.fill(values.repo);
  await repoField.press("Enter");
  const branch = field(window, id, "branch");
  await expect(branch).toBeEnabled();
  await expect(branch.locator(`option[value="${values.branch}"]`)).toHaveCount(1);
  await branch.selectOption(values.branch);
  await field(window, id, "model").selectOption(values.model);
  await expect
    .poll(async () => (await readout(window)).containers.find((container) => container.id === id))
    .toMatchObject({ kind: "session", ...values });
};

const dropSessionBelow = async (window: Page, id: string) => {
  const canvas = await boxOf(window.getByTestId("canvas"));
  const above = await boxOf(frame(window, id));
  await window.getByTestId(paletteTestId("session")).dragTo(window.getByTestId("canvas"), {
    targetPosition: {
      x: above.x - canvas.x + 20,
      y: above.y - canvas.y + above.height + 120,
    },
  });
};

test("A workspace and two session containers keep every setting through save and reopen", async () => {
  repo = await createTmpRepo({ commit: true });
  let window = await launch();

  await expect(frame(window, "workspace-1")).toBeVisible();
  await expect(frame(window, "session-1")).toBeVisible();

  await dropSessionBelow(window, "session-1");
  await expect(frame(window, "session-2")).toBeVisible();
  await expect
    .poll(async () => (await readout(window)).containers.map((container) => container.id))
    .toEqual(["workspace-1", "session-1", "session-2"]);

  await selectContainer(window, "workspace-1");
  for (const absent of ["name", "repo", "branch"] as const) {
    await expect(field(window, "workspace-1", absent)).toHaveCount(0);
  }
  await field(window, "workspace-1", "model").selectOption("haiku");
  await setSession(window, "session-1", {
    name: "api",
    repo: repo.path,
    branch: "main",
    model: "opus",
  });
  await setSession(window, "session-2", {
    name: "web",
    repo: repo.path,
    branch: "main",
    model: "haiku",
  });

  await window.getByTestId(controlTestIds.save).click();
  const expected = [
    { id: "workspace-1", kind: "workspace", model: "haiku", members: 2 },
    {
      id: "session-1",
      kind: "session",
      name: "api",
      repo: repo.path,
      branch: "main",
      model: "opus",
      members: 2,
    },
    {
      id: "session-2",
      kind: "session",
      name: "web",
      repo: repo.path,
      branch: "main",
      model: "haiku",
      members: 2,
    },
  ];
  await expect.poll(() => settingsOf(savedContainers())).toEqual(expected);

  window = await relaunch();

  for (const id of ["workspace-1", "session-1", "session-2"]) {
    await expect(frame(window, id)).toBeVisible();
  }
  await expect.poll(async () => settingsOf((await readout(window)).containers)).toEqual(expected);

  await selectContainer(window, "workspace-1");
  await expect(field(window, "workspace-1", "model")).toHaveValue("haiku");
  for (const { id, name, model } of [
    { id: "session-1", name: "api", model: "opus" },
    { id: "session-2", name: "web", model: "haiku" },
  ]) {
    await selectContainer(window, id);
    await expect(field(window, id, "name")).toHaveValue(name);
    await expect(field(window, id, "repo")).toHaveValue(repo.path);
    await expect(field(window, id, "branch")).toHaveValue("main");
    await expect(field(window, id, "model")).toHaveValue(model);
  }
});

test("Deleting the workspace makes a Library that can't be built, in the editor and on its card", async () => {
  let window = await launch();
  const workspaceNodes =
    (await readout(window)).containers.find((container) => container.kind === "workspace")?.nodes ??
    [];
  expect(workspaceNodes).toHaveLength(2);

  await selectContainer(window, "workspace-1");
  await window.getByTestId(controlTestIds.delete).click();

  await expect(frame(window, "workspace-1")).toHaveCount(0);
  await expect
    .poll(async () => {
      const current = await readout(window);
      return {
        containers: current.containers.map((container) => container.kind),
        left: current.nodes.filter((node) => workspaceNodes.includes(node.id)),
      };
    })
    .toEqual({ containers: ["session"], left: [] });
  await expect(window.getByTestId(controlTestIds.build)).toBeDisabled();
  const reason = window.getByTestId(pageTestIds.buildDisabledReason);
  await expect(reason).toBeVisible();
  await expect(reason).toHaveText(/library/i);
  await expect(reason).toHaveText(/cannot be built/i);

  await window.getByTestId(controlTestIds.save).click();
  await expect
    .poll(() => savedContainers().map((container) => container.kind))
    .toEqual(["session"]);
  const flowId = latestFlowId(home);
  if (flowId === undefined) throw new Error("the blueprint was not saved");

  await window.getByTestId(controlTestIds.back).click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  const card = window.getByTestId(pageTestIds.blueprintCard(flowId));
  await expect(card.getByTestId(pageTestIds.blueprintKind(flowId))).toHaveText("Incomplete");
  const cardBuild = card.getByTestId(pageTestIds.blueprintBuild(flowId));
  await expect(cardBuild).toBeDisabled();
  await expect
    .poll(async () => `${(await cardBuild.getAttribute("title")) ?? ""} ${await card.innerText()}`)
    .toMatch(/library[^]*cannot be built|cannot be built[^]*library/i);

  window = await relaunch();
  await expect(window.getByTestId(controlTestIds.build)).toBeDisabled();
  await expect(window.getByTestId(pageTestIds.buildDisabledReason)).toHaveText(/cannot be built/i);
});

const finishedNodes = (runId: string): string[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT node_id FROM run_nodes WHERE run_id = ? AND finished_at IS NOT NULL ORDER BY node_id",
        )
        .all(runId) as { node_id: string }[]
    ).map(({ node_id }) => node_id);
  } finally {
    db.close();
  }
};

const withInstructions = (flow: Flow, nodeId: string, instructions: string): Flow => ({
  ...flow,
  nodes: flow.nodes.map((node) =>
    node.id === nodeId && node.type === "agent"
      ? { ...node, settings: { ...node.settings, instructions } }
      : node,
  ),
});

const gitOut = async (cwd: string, ...args: string[]) =>
  (await git("git", ["-C", cwd, ...args])).stdout.trim();

const identity = ["-c", "user.name=Flowdeck Test", "-c", "user.email=test@flowdeck.invalid"];

test("Two session containers build a worktree each from their own repo and base, and a run no instruction starts leaves both not started", async () => {
  test.setTimeout(120_000);
  repo = await createTmpRepo({ commit: true });
  otherRepo = await createTmpRepo({ commit: true });
  await gitOut(otherRepo.path, "checkout", "--quiet", "-b", "develop");
  await gitOut(otherRepo.path, ...identity, "commit", "--quiet", "--allow-empty", "-m", "dev");
  await gitOut(otherRepo.path, "checkout", "--quiet", "main");
  const { flowId } = seedBlueprint(
    home,
    "Two apps",
    sessionsWorkflow(
      [
        { name: "android", repo: repo.path, branch: "main", model: "haiku", members: ["Plan"] },
        {
          name: "ios",
          repo: otherRepo.path,
          branch: "develop",
          model: "haiku",
          members: ["Review"],
        },
      ],
      { workspace: ["Coordinate"] },
    ),
  );
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();

  await window.getByTestId(controlTestIds.build).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
  for (const hidden of [
    buildDialogTestIds.repo,
    buildDialogTestIds.base,
    buildDialogTestIds.branchNew,
    buildDialogTestIds.branchExisting,
  ]) {
    await expect(window.getByTestId(hidden)).toHaveCount(0);
  }
  await expect(window.getByTestId(buildDialogTestIds.sessionRepo("android"))).toHaveText(repo.path);
  await expect(window.getByTestId(buildDialogTestIds.sessionBranch("android"))).toHaveText(
    "from main",
  );
  await expect(window.getByTestId(buildDialogTestIds.sessionRepo("ios"))).toHaveText(
    otherRepo.path,
  );
  await expect(window.getByTestId(buildDialogTestIds.sessionBranch("ios"))).toHaveText(
    "from develop",
  );
  await window.getByTestId(buildDialogTestIds.cancel).click();

  const buildId = await buildOnCanvas(window, home, "two-apps");
  const dir = join(home, "workspaces", buildId);
  const android = sessionWorktree(dir, "android", repo.path);
  const ios = sessionWorktree(dir, "ios", otherRepo.path);
  expect(buildWorktreePaths(home, buildId)).toEqual([android, ios]);
  expect(await gitOut(android, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
    "flowdeck/two-apps-android",
  );
  expect(await gitOut(ios, "rev-parse", "--abbrev-ref", "HEAD")).toBe("flowdeck/two-apps-ios");
  expect(await gitOut(android, "rev-parse", "HEAD")).toBe(
    await gitOut(repo.path, "rev-parse", "main"),
  );
  expect(await gitOut(ios, "rev-parse", "HEAD")).toBe(
    await gitOut(otherRepo.path, "rev-parse", "develop"),
  );
  expect(await gitOut(repo.path, "worktree", "list", "--porcelain")).toContain(
    `worktree ${await realpath(android)}`,
  );
  expect(await gitOut(otherRepo.path, "worktree", "list", "--porcelain")).toContain(
    `worktree ${await realpath(ios)}`,
  );

  await runFromDetail(window);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 30_000,
  });
  for (const name of ["android", "ios"]) {
    const status = window.getByTestId(pageTestIds.runContainerStatus(name));
    await expect(status).toHaveAttribute("data-status", "not-started");
    await expect(status).toHaveText("not started");
  }
  expect(finishedNodes(await runIdOf(home, buildId))).toEqual([
    "workspace-1-coordinate",
    "workspace-1-start",
    "workspace-1-stop",
  ]);
});

test("A workspace instruction that starts and waits for android runs android's nodes to done", async () => {
  test.setTimeout(120_000);
  repo = await createTmpRepo({ commit: true });
  const { flowId } = seedBlueprint(
    home,
    "Starts android",
    withInstructions(
      sessionsWorkflow(
        [
          { name: "android", repo: repo.path, branch: "main", model: "haiku", members: ["Plan"] },
          { name: "ios", repo: repo.path, branch: "main", model: "haiku", members: ["Review"] },
        ],
        { workspace: ["Coordinate"] },
      ),
      "workspace-1-coordinate",
      "fake: start android\nfake: wait android",
    ),
  );
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();

  const buildId = await buildOnCanvas(window, home, "starts-android");
  await runFromDetail(window);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 60_000,
  });
  const runId = await runIdOf(home, buildId);
  const android = window.getByTestId(pageTestIds.runContainerGroup("android"));
  await expect(window.getByTestId(pageTestIds.runContainerStatus("android"))).toHaveAttribute(
    "data-status",
    "done",
  );
  for (const nodeId of ["session-1-start", "session-1-plan", "session-1-stop"]) {
    await expect(android.getByTestId(pageTestIds.runStageStatus(runId, nodeId))).toHaveAttribute(
      "data-status",
      "done",
    );
  }
  await expect(window.getByTestId(pageTestIds.runContainerStatus("ios"))).toHaveAttribute(
    "data-status",
    "not-started",
  );
  expect(finishedNodes(runId)).toEqual([
    "session-1-plan",
    "session-1-start",
    "session-1-stop",
    "workspace-1-coordinate",
    "workspace-1-start",
    "workspace-1-stop",
  ]);
});

test("The run page's terminal switches between the workspace and a session it started", async () => {
  test.setTimeout(120_000);
  repo = await createTmpRepo({ commit: true });
  const { flowId } = seedBlueprint(
    home,
    "Watch android",
    withInstructions(
      withInstructions(
        sessionsWorkflow(
          [
            { name: "android", repo: repo.path, branch: "main", model: "haiku", members: ["Plan"] },
            { name: "ios", repo: repo.path, branch: "main", model: "haiku", members: ["Review"] },
          ],
          { workspace: ["Coordinate"] },
        ),
        "workspace-1-coordinate",
        "fake: start android\nfake: wait android",
      ),
      "session-1-plan",
      "fake: hang",
    ),
  );
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();

  const buildId = await buildOnCanvas(window, home, "watch-android");
  await runFromDetail(window);
  const runId = await runIdOf(home, buildId);
  await expect(
    window
      .getByTestId(pageTestIds.runContainerGroup("android"))
      .getByTestId(pageTestIds.runStageStatus(runId, "session-1-plan")),
  ).toHaveAttribute("data-status", "running", { timeout: 60_000 });

  await window.getByTestId("run-tab-terminal").click();
  const picker = window.getByTestId(pageTestIds.terminalSessionPicker);
  const workspace = picker.getByTestId(pageTestIds.terminalSessionOption("workspace"));
  const android = picker.getByTestId(pageTestIds.terminalSessionOption("android"));
  await expect(workspace).toHaveAttribute("aria-pressed", "true");
  await expect(window.getByTestId("terminal-view")).toContainText("Fake Claude in", {
    timeout: 20_000,
  });

  await android.click();

  await expect(android).toHaveAttribute("aria-pressed", "true");
  await expect(workspace).toHaveAttribute("aria-pressed", "false");
  await expect(window.getByTestId("terminal-view")).toContainText("NODE session-1-plan", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("terminal-view")).not.toContainText("Fake Claude in");

  await window.getByTestId(pageTestIds.runStop).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
});
