import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlTestIds, paletteTestId, readoutTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import {
  branch,
  flow,
  fork,
  prompt,
  script,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const git = async (repo: string, ...args: string[]) =>
  (await promisify(execFile)("git", ["-C", repo, ...args])).stdout;

let home: string;
let launched: LaunchedApp | undefined;
const cleanups: (() => Promise<void>)[] = [];

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-ed-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
});

const launch = async (colorScheme?: "dark") => {
  launched = await launchApp({
    home,
    logPath: test.info().outputPath("app.log"),
    ...(colorScheme === undefined ? {} : { colorScheme }),
  });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched.window;
};

const at = <N extends object>(node: N, x: number, y: number, label?: string) => ({
  ...node,
  position: { x, y },
  ...(label === undefined ? {} : { label }),
});

type Readout = Flow;

const readout = async (window: Page): Promise<Readout> =>
  JSON.parse((await window.getByTestId(readoutTestIds.flow).textContent()) ?? "") as Readout;

const selection = async (window: Page): Promise<string[]> =>
  JSON.parse((await window.getByTestId(readoutTestIds.selection).textContent()) ?? "") as string[];

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const connectPorts = async (window: Page, from: Locator, to: Locator) => {
  const source = await boxOf(from);
  const target = await boxOf(to);
  await window.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await window.mouse.down();
  await window.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
    steps: 12,
  });
  await window.mouse.up();
};

const reviewShot = async (window: Page, name: string) => {
  await window.mouse.move(1, 1);
  const path = test.info().outputPath(`${name}.png`);
  await window.screenshot({ path });
  await test.info().attach(`${name}.png`, { path, contentType: "image/png" });
};

const twoScripts = (folder: string) => {
  const seeded = flow(
    [
      at(script("s1", { settings: { command: "echo", args: ["one"] } }), 80, 120, "One"),
      at(script("s2", { settings: { command: "echo", args: ["two"] } }), 380, 120, "Two"),
    ],
    [thenWire("s1", "s2")],
  );
  return {
    ...seeded,
    session: { ...seeded.session, workingFolder: { kind: "path", path: folder } },
  };
};

const tempFolder = async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "fd-ed-wf-")));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
};

test("A wire can be selected, deleted with Delete, and brought back with Undo", async () => {
  seedFlow(home, twoScripts(await tempFolder()));
  const window = await launch("dark");
  const edge = window.getByTestId("rf__edge-s1:out->s2:in");
  await expect(edge).toBeAttached();

  const source = await boxOf(window.getByTestId("port-s1-out"));
  const target = await boxOf(window.getByTestId("port-s2-in"));
  await window.mouse.click((source.x + target.x) / 2, source.y + source.height / 2);

  await expect(window.getByTestId(readoutTestIds.wires)).toHaveText('["s1:out->s2:in"]');
  await expect(edge).toHaveClass(/selected/);
  await expect(window.getByTestId(controlTestIds.delete)).toBeEnabled();
  await reviewShot(window, "wire");

  await window.keyboard.press("Delete");
  await expect.poll(async () => (await readout(window)).wires).toEqual([]);
  await expect(edge).toHaveCount(0);
  await expect((await readout(window)).nodes.map((node) => node.id)).toEqual(["s1", "s2"]);

  await window.keyboard.press("Meta+z");
  await expect.poll(async () => (await readout(window)).wires.length).toBe(1);
  await expect(edge).toBeAttached();
});

test("Wiring a Fork to a Prompt is refused with a plain reason", async () => {
  seedFlow(home, flow([at(fork("f1"), 80, 120, "Split"), at(prompt("p1"), 300, 120, "Draft")], []));
  const window = await launch();

  await connectPorts(window, window.getByTestId("port-f1-out"), window.getByTestId("port-p1-in"));

  await expect(window.getByTestId("canvas-message")).toHaveText(
    "Can't connect Split to Draft: Draft is a parallel branch that is not an Agent.",
  );
  expect((await readout(window)).wires).toEqual([]);
});

test("A refused Build lists every problem in plain words, and a click selects its node", async () => {
  const folder = await tempFolder();
  const seeded = flow(
    [
      at(prompt("p1", { settings: { instructions: "" } }), 80, 120, "Draft the plan"),
      at(script("s1", { settings: { command: "" } }), 900, 700, "Run the tests"),
    ],
    [thenWire("p1", "s1")],
  );
  seedFlow(home, {
    ...seeded,
    session: { ...seeded.session, workingFolder: { kind: "path", path: folder } },
  });
  const window = await launch("dark");

  await window.getByTestId(controlTestIds.build).click();

  const problems = window.getByTestId("build-problems");
  await expect(problems).toContainText("2 problems");
  await expect(window.getByTestId("build-problem-0")).toHaveText(
    "Draft the planWrite what the prompt should do.",
  );
  await expect(window.getByTestId("build-problem-1")).toHaveText(
    "Run the testsWrite the command to run.",
  );
  await expect(problems).not.toContainText("required-settings");
  await expect(window.getByTestId("run-error")).toHaveCount(0);
  await reviewShot(window, "problems");

  await window.getByTestId("build-problem-1").click();
  await expect.poll(() => selection(window)).toEqual(["s1"]);
  await expect(window.getByTestId("node-problems")).toHaveText("Write the command to run.");
  const node = await boxOf(window.getByTestId("node-s1"));
  const canvas = await boxOf(window.getByTestId("canvas"));
  await expect
    .poll(async () => {
      const box = await boxOf(window.getByTestId("node-s1"));
      return box.x > canvas.x && box.x + box.width < canvas.x + canvas.width;
    })
    .toBe(true);
  expect(node.width).toBeGreaterThan(0);
});

test("A Branch picks its flag from the Trigger's flags, and its wires say yes and no", async () => {
  seedFlow(
    home,
    flow(
      [
        at(trigger("t", { settings: { flags: { e2e: true, docs: false } } }), 40, 120),
        at(branch("b", "e2e"), 240, 120),
        at(script("y"), 460, 60),
        at(script("n"), 460, 260),
      ],
      [
        thenWire("t", "b"),
        { kind: "then", from: { node: "b", port: "yes" }, to: { node: "y", port: "in" } },
        { kind: "then", from: { node: "b", port: "no" }, to: { node: "n", port: "in" } },
      ],
    ),
  );
  const window = await launch();

  await expect(window.getByTestId("port-label-b-yes")).toHaveText("yes");
  await expect(window.getByTestId("port-label-b-no")).toHaveText("no");
  await expect(window.getByTestId("branch-wire-b-yes")).toHaveText("yes");
  await expect(window.getByTestId("branch-wire-b-no")).toHaveText("no");

  await window.getByTestId("node-b").click();
  const flag = window.getByTestId("node-setting-flag");
  await expect(flag.locator("option")).toHaveText(["e2e (on by default)", "docs (off by default)"]);
  await flag.selectOption("docs");
  await expect
    .poll(async () => (await readout(window)).nodes.find((node) => node.id === "b")?.settings)
    .toEqual({ flag: "docs" });
  await expect(window.getByTestId("node-type-description")).not.toContainText("verdict");
});

test("A dropped Agent shows an issue until its task is written", async () => {
  const window = await launch();
  await window.getByTestId(paletteTestId("agent")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 300, y: 200 },
  });
  const issue = window.getByTestId("node-issue-agent-1");
  await expect(issue).toHaveText("Write what the agent should do.");
  await window.getByTestId("node-agent-1").click();

  const instructions = window.getByTestId("node-setting-instructions");
  await expect(instructions).toHaveValue("");
  await expect(instructions).toHaveAttribute("placeholder", "Describe the agent's task.");
  await instructions.fill("Review the plan.");
  await instructions.blur();

  await expect(issue).toHaveCount(0);
});

const copyable = () =>
  flow([at(prompt("a"), 80, 120, "Plan"), at(script("b"), 380, 120, "Test")], [thenWire("a", "b")]);

test("Cmd+C and Cmd+V paste a copy with new ids and its wire, and Cmd+D duplicates", async () => {
  seedFlow(home, copyable());
  const window = await launch();
  await window.getByTestId("node-a").click();
  await window.getByTestId("node-b").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => selection(window)).toEqual(["a", "b"]);

  await window.keyboard.press("Meta+c");
  await window.keyboard.press("Meta+v");

  await expect.poll(() => selection(window)).toEqual(["prompt-1", "script-1"]);
  const pasted = await readout(window);
  expect(pasted.nodes.map(({ id, label }) => `${id}:${label}`)).toEqual([
    "a:Plan",
    "b:Test",
    "prompt-1:Plan",
    "script-1:Test",
  ]);
  expect(pasted.wires.map(({ from, to }) => `${from.node}>${to.node}`)).toEqual([
    "a>b",
    "prompt-1>script-1",
  ]);
  await expect(window.getByTestId("node-prompt-1")).toBeVisible();

  await window.getByTestId("node-a").click();
  await window.keyboard.press("Meta+d");
  await expect.poll(() => selection(window)).toEqual(["prompt-2"]);

  await window.keyboard.press("Meta+z");
  await expect.poll(async () => (await readout(window)).nodes.length).toBe(4);
});

test("Cmd+C with no node selected is left to the page, so selected text still copies", async () => {
  seedFlow(home, copyable());
  const window = await launch();
  const pressed = (key: string) =>
    window.evaluate((pressedKey) => {
      const event = new KeyboardEvent("keydown", {
        key: pressedKey,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }, key);
  await expect.poll(() => selection(window)).toEqual([]);

  expect(await pressed("c")).toBe(false);

  await window.getByTestId("node-a").click();
  expect(await pressed("c")).toBe(true);
});

test("A node is renamed in place by double-click or Enter, and Escape keeps the name", async () => {
  seedFlow(home, copyable());
  const window = await launch();

  await window.getByTestId("node-a").click();
  await window.getByTestId("node-a").dblclick();
  const field = window.getByTestId("node-rename");
  await expect(field).toBeFocused();
  await field.fill("Write the plan");
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  await expect(window.getByTestId("node-a")).toContainText("Write the plan");

  await window.getByTestId("node-b").click();
  await window.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await field.fill("Never kept");
  await field.press("Escape");
  await expect(field).toHaveCount(0);

  const labels = (await readout(window)).nodes.map((node) => node.label);
  expect(labels).toEqual(["Write the plan", "Test"]);
  await window.keyboard.press("Meta+z");
  await expect
    .poll(async () => (await readout(window)).nodes.map((node) => node.label))
    .toEqual(["Plan", "Test"]);
});

const zoomOf = async (window: Page) =>
  window
    .locator(".react-flow__viewport")
    .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

test("The view fits a blueprint when it opens, and Cmd+= Cmd+- Cmd+0 zoom", async () => {
  seedFlow(
    home,
    flow([at(prompt("near"), 0, 0), at(prompt("far"), 1200, 1000)], [thenWire("near", "far")]),
  );
  const window = await launch();
  const canvas = await boxOf(window.getByTestId("canvas"));
  for (const id of ["near", "far"]) {
    const box = await boxOf(window.getByTestId(`node-${id}`));
    expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    expect(box.x).toBeGreaterThanOrEqual(canvas.x);
  }

  await window.getByTestId("canvas").click({ position: { x: 20, y: canvas.height - 60 } });
  await window.keyboard.press("Meta+0");
  await expect.poll(() => zoomOf(window)).toBe(1);
  await window.keyboard.press("Meta+=");
  await expect.poll(() => zoomOf(window)).toBeGreaterThan(1);
  await window.keyboard.press("Meta+0");
  await window.keyboard.press("Meta+-");
  await expect.poll(() => zoomOf(window)).toBeLessThan(1);
});

test("A new blueprint with one Script asks for its folder at Build, then runs", async () => {
  const folder = await tempFolder();
  const window = await launch();
  await window.getByTestId(paletteTestId("script")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 300, y: 200 },
  });
  await window.getByTestId("node-script-1").click();
  await window.getByTestId("node-setting-command").fill("pwd");
  await window.getByTestId("node-setting-command").press("Enter");

  await window.getByTestId(controlTestIds.run).click();

  await expect(window.getByTestId("build-problem-0")).toHaveText(
    "SessionChoose the folder this blueprint works in, in the session settings.",
  );
  await expect(window.getByTestId("session-settings")).toBeVisible();
  await expect(window.getByTestId("session-working-folder-kind")).toHaveValue("path");
  await expect(window.getByTestId("session-working-folder-path-issue")).toBeVisible();
  await window.getByTestId("session-working-folder-path").fill(folder);
  await window.getByTestId("session-working-folder-path").press("Enter");

  await window.getByTestId(controlTestIds.run).click();

  await expect(window.getByTestId("node-status-script-1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  const app = launched;
  launched = undefined;
  await app?.close();
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    expect(db.prepare("SELECT node_id, finished_at FROM run_nodes").all()).toEqual([
      { node_id: "script-1", finished_at: expect.any(String) },
    ]);
    expect(db.prepare("SELECT cwd FROM run_sessions").all()).toEqual([{ cwd: folder }]);
  } finally {
    db.close();
  }
});

test("The gear picks the model, permission mode and the repository's branch", async () => {
  const repo: TmpRepo = await createTmpRepo({ commit: true });
  cleanups.push(() => repo.cleanup());
  await git(repo.path, "branch", "dev");
  const seeded = flow([at(script("s1"), 80, 120)], []);
  seedFlow(home, {
    ...seeded,
    session: {
      ...seeded.session,
      workingFolder: { kind: "worktree", branch: "main", repo: repo.path },
    },
  });
  const window = await launch("dark");

  await window.getByTestId(controlTestIds.sessionChip).click();
  await expect(window.getByTestId("session-settings")).toBeVisible();
  await expect(window.getByTestId("session-name")).toHaveValue("main");
  const branchPick = window.getByTestId("session-working-folder-branch");
  await expect(branchPick.locator("option")).toHaveText(["dev", "main"]);
  await expect(window.getByTestId("session-model").locator("option").first()).toHaveText(
    "Sonnet (latest)",
  );
  await expect(window.getByTestId("session-permission-mode").locator("option")).toHaveText([
    "Ask before risky actions",
    "Accept file edits without asking",
    "Plan only, change nothing",
    "Never ask (skip all checks)",
  ]);
  await reviewShot(window, "gear");

  await branchPick.selectOption("dev");
  await window.getByTestId("session-model").selectOption("haiku");
  await window.getByTestId("session-permission-mode").selectOption("acceptEdits");
  await expect
    .poll(async () => (await readout(window)).session)
    .toMatchObject({
      model: "haiku",
      permissionMode: "acceptEdits",
      workingFolder: { kind: "worktree", branch: "dev", repo: repo.path },
    });
  await expect(window.getByTestId("session-chip")).toContainText("Haiku (latest)");
});

const runInWorktree = async (command: string) => {
  const repo: TmpRepo = await createTmpRepo({ commit: true });
  cleanups.push(() => repo.cleanup());
  const seeded = flow(
    [at(script("s1", { settings: { command: "sh", args: ["-c", command] } }), 80, 120)],
    [],
  );
  seedFlow(home, {
    ...seeded,
    session: {
      ...seeded.session,
      workingFolder: { kind: "worktree", branch: "main", repo: repo.path },
    },
  });
  const window = await launch();
  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  return { window, repo };
};

const appLog = () => readFile(test.info().outputPath("app.log"), "utf8");

test("A finished worktree run that changed nothing leaves no flowdeck branch or worktree behind", async () => {
  const { repo } = await runInWorktree("echo unchanged");

  await expect
    .poll(async () => (await git(repo.path, "branch", "--list", "flowdeck/*")).trim())
    .toBe("");
  expect(
    (await git(repo.path, "worktree", "list", "--porcelain")).match(/^worktree /gm),
  ).toHaveLength(1);
  await expect
    .poll(appLog)
    .toMatch(/removed worktree .*worktrees\/[0-9a-f]{8} and flowdeck\/[0-9a-f]{8}/);
});

test("A finished worktree run that wrote a file keeps its branch and worktree, and the Activity says where", async () => {
  const { window, repo } = await runInWorktree("echo made > made.txt");

  await expect.poll(appLog).toMatch(/Kept the worktree/);
  const branch = (
    await git(repo.path, "branch", "--list", "--format=%(refname:short)", "flowdeck/*")
  ).trim();
  expect(branch).toMatch(/^flowdeck\/[0-9a-f]{8}$/);
  const id8 = branch.slice("flowdeck/".length);
  const path = join(home, "worktrees", id8);
  expect(await git(repo.path, "worktree", "list", "--porcelain")).toContain(
    `worktree ${await realpath(path)}`,
  );
  expect(await readFile(join(path, "made.txt"), "utf8")).toBe("made\n");
  await window.getByTestId("run-tab-activity").click();
  await expect(window.locator('[data-kind="kept"]')).toHaveText(
    `Kept the worktree ${path} and branch ${branch}: they hold this run's changes.`,
  );
});
