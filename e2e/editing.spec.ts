import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  branchVariableTestId,
  buildConfigTestIds,
  buildDialogTestIds,
  controlTestIds,
  paletteTestId,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import {
  agent,
  branch,
  fileWire,
  flow,
  fork,
  gate,
  loop,
  onMainFlow,
  output,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildAndRun } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";

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
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
    for (const cleanup of cleanups.splice(0)) await cleanup();
  }
});

const launch = async (colorScheme?: "dark", writes?: Record<string, Record<string, string>>) => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(writes === undefined ? {} : { writes }),
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

const twoScripts = () =>
  flow([at(agent("s1"), 80, 120, "One"), at(agent("s2"), 380, 120, "Two")], [thenWire("s1", "s2")]);

const tempRepo = async () => {
  const repo: TmpRepo = await createTmpRepo({ commit: true });
  cleanups.push(() => repo.cleanup());
  return repo;
};

test("A wire can be selected, deleted with Delete, and brought back with Undo", async () => {
  seedFlow(home, twoScripts());
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

test("Wiring a Fork to a Gate is refused with a plain reason", async () => {
  seedFlow(home, flow([at(fork("f1"), 80, 120, "Split"), at(gate("p1"), 300, 120, "Draft")], []));
  const window = await launch();

  await connectPorts(window, window.getByTestId("port-f1-out"), window.getByTestId("port-p1-in"));

  await expect(window.getByTestId("canvas-message")).toHaveText(
    "Can't connect Split to Draft: Draft is a parallel branch that is not an Agent.",
  );
  expect((await readout(window)).wires).toEqual([]);
});

test("A refused Build lists every problem in plain words, and a click selects its node", async () => {
  const repo = await tempRepo();
  seedFlow(
    home,
    flow(
      [
        at(trigger("start"), -200, 120, "Start"),
        at(agent("p1", { settings: { instructions: "" } }), 80, 120, "Draft the plan"),
        at(agent("s1", { settings: { instructions: "" } }), 900, 700, "Run the tests"),
        at(output("stop"), 1200, 700, "Stop"),
      ],
      [thenWire("start", "p1"), thenWire("p1", "s1"), thenWire("s1", "stop")],
    ),
    repo.path,
  );
  const window = await launch("dark");

  await window.getByTestId(controlTestIds.build).click();
  await window.getByTestId(buildDialogTestIds.name).fill("refused");
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await window.getByTestId(buildDialogTestIds.cancel).click();

  const problems = window.getByTestId("build-problems");
  await expect(problems).toContainText("2 problems");
  await expect(window.getByTestId("build-problem-0")).toHaveText(
    "Draft the planWrite what the agent should do.",
  );
  await expect(window.getByTestId("build-problem-1")).toHaveText(
    "Run the testsWrite what the agent should do.",
  );
  await expect(problems).not.toContainText("required-settings");
  await expect(window.getByTestId("run-error")).toHaveCount(0);
  await reviewShot(window, "problems");

  await window.getByTestId("build-problem-1").click();
  await expect.poll(() => selection(window)).toEqual(["s1"]);
  await expect(window.getByTestId("node-problems")).toHaveText("Write what the agent should do.");
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

test("A Branch picks a yes/no variable, and its wires say yes and no", async () => {
  const seeded = flow(
    [
      at(trigger("t"), 40, 120),
      at(branch("b", "e2e"), 240, 120),
      at(agent("y"), 460, 60),
      at(agent("n"), 460, 260),
    ],
    [
      thenWire("t", "b"),
      { kind: "then", from: { node: "b", port: "yes" }, to: { node: "y", port: "in" } },
      { kind: "then", from: { node: "b", port: "no" }, to: { node: "n", port: "in" } },
    ],
  );
  seedFlow(home, {
    ...seeded,
    session: {
      ...seeded.session,
      buildConfig: {
        variables: [
          { name: "e2e", kind: "yesno", default: true },
          { name: "ticket", kind: "text" },
          { name: "docs", kind: "yesno", default: false },
        ],
      },
    },
  });
  const window = await launch();

  await expect(window.getByTestId("port-label-b-yes")).toHaveText("yes");
  await expect(window.getByTestId("port-label-b-no")).toHaveText("no");
  await expect(window.getByTestId("branch-wire-b-yes")).toHaveText("yes");
  await expect(window.getByTestId("branch-wire-b-no")).toHaveText("no");

  await window.getByTestId("node-b").click();
  const variable = window.getByTestId(branchVariableTestId);
  await expect(variable.locator("option")).toHaveText(["e2e", "docs"]);
  await variable.selectOption("docs");
  await expect
    .poll(async () => (await readout(window)).nodes.find((node) => node.id === "b")?.settings)
    .toEqual({ variable: "docs" });
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
  flow([at(agent("a"), 80, 120, "Plan"), at(agent("b"), 380, 120, "Test")], [thenWire("a", "b")]);

test("Cmd+C and Cmd+V paste a copy with new ids and its wire, and Cmd+D duplicates", async () => {
  seedFlow(home, copyable());
  const window = await launch();
  await window.getByTestId("node-a").click();
  await window.getByTestId("node-b").click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => selection(window)).toEqual(["a", "b"]);

  await window.keyboard.press("Meta+c");
  await window.keyboard.press("Meta+v");

  await expect.poll(() => selection(window)).toEqual(["agent-1", "agent-2"]);
  const pasted = await readout(window);
  expect(pasted.nodes.map(({ id, label }) => `${id}:${label}`)).toEqual([
    "a:Plan",
    "b:Test",
    "agent-1:Plan",
    "agent-2:Test",
  ]);
  expect(pasted.wires.map(({ from, to }) => `${from.node}>${to.node}`)).toEqual([
    "a>b",
    "agent-1>agent-2",
  ]);
  await expect(window.getByTestId("node-agent-1")).toBeVisible();

  await window.getByTestId("node-a").click();
  await window.keyboard.press("Meta+d");
  await expect.poll(() => selection(window)).toEqual(["agent-3"]);

  await window.keyboard.press("Meta+z");
  await expect.poll(async () => (await readout(window)).nodes.length).toBe(4);
});

const loopWithBody = () =>
  flow(
    [
      at(loop("L", { settings: { cap: 5 } }), 80, 120, "Retry"),
      at(agent("p", { parent: "L" }), 100, 200, "Fix"),
      at(agent("s", { parent: "L" }), 320, 200, "Test"),
    ],
    [thenWire("p", "s")],
  );

const childrenIn = async (window: Page, id: string) =>
  (await readout(window)).nodes.filter((node) => node.parent === id).map((node) => node.id);

test("Frame only from the node menu adds an empty Loop with the same settings, and Duplicate keeps the body", async () => {
  seedFlow(home, loopWithBody());
  const window = await launch();

  await window.getByTestId("node-L").click({ button: "right" });
  await window.getByTestId("node-menu-frame-only").click();

  await expect(window.getByTestId("node-loop-1")).toContainText("max 5");
  const framed = await readout(window);
  expect(framed.nodes.map((node) => node.id)).toEqual(["L", "p", "s", "loop-1"]);
  expect(framed.nodes.find((node) => node.id === "loop-1")).toMatchObject({
    label: "Retry",
    settings: { cap: 5 },
  });
  expect(await childrenIn(window, "loop-1")).toEqual([]);
  expect(framed.wires).toHaveLength(1);

  await window.keyboard.press("Meta+z");
  await expect(window.getByTestId("node-loop-1")).toHaveCount(0);
  expect((await readout(window)).nodes.map((node) => node.id)).toEqual(["L", "p", "s"]);

  await window.getByTestId("node-L").click({ button: "right" });
  await window.getByTestId("node-menu-duplicate").click();
  await expect.poll(() => childrenIn(window, "loop-1")).toEqual(["agent-1", "agent-2"]);

  await window.getByTestId("node-L").click();
  await window.keyboard.press("Meta+d");
  await expect.poll(() => childrenIn(window, "loop-2")).toEqual(["agent-3", "agent-4"]);
  expect((await readout(window)).wires).toHaveLength(3);
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

test("A File wire is renamed from its label, stays selected, and Undo brings the old name back", async () => {
  seedFlow(
    home,
    flow(
      [at(agent("plan"), 80, 160, "Planner"), at(agent("build"), 420, 160, "Builder")],
      [
        thenWire("plan", "build"),
        fileWire("plan", "build", "brief.md"),
        fileWire("plan", "build", "notes.md"),
      ],
    ),
  );
  const window = await launch();
  const notesId = "plan:file-out->build:file-in:notes.md";
  const planId = "plan:file-out->build:file-in:plan.md";
  const files = async () =>
    (await readout(window)).wires.flatMap((wire) => (wire.kind === "file" ? [wire.file] : []));
  const label = await boxOf(window.getByTestId("file-wire-plan-build-notes.md"));
  const clickLabel = () =>
    window.mouse.click(label.x + label.width / 2, label.y + label.height / 2);

  await clickLabel();
  await expect(window.getByTestId(readoutTestIds.wires)).toHaveText(JSON.stringify([notesId]));
  await clickLabel();
  const field = window.getByTestId(`file-wire-name-${notesId}`);
  await expect(field).toBeFocused();
  await field.fill("plan.md");
  await field.press("Enter");

  await expect(field).toHaveCount(0);
  await expect(window.getByTestId("file-wire-plan-build-plan.md")).toHaveText("plan.md");
  await expect(window.getByTestId(`rf__edge-${planId}`)).toHaveClass(/selected/);
  await expect(window.getByTestId(readoutTestIds.wires)).toHaveText(JSON.stringify([planId]));
  expect(await files()).toEqual(["brief.md", "plan.md"]);

  await window.keyboard.press("Meta+z");
  await expect(window.getByTestId("file-wire-plan-build-notes.md")).toHaveText("notes.md");
  await expect(window.getByTestId(`rf__edge-${notesId}`)).toHaveClass(/selected/);
  await expect(window.getByTestId(readoutTestIds.wires)).toHaveText(JSON.stringify([notesId]));
  expect(await files()).toEqual(["brief.md", "notes.md"]);

  await clickLabel();
  await expect(field).toBeFocused();
  await field.fill("brief.md");
  await field.press("Enter");

  await expect(window.getByTestId("canvas-message")).toHaveText(
    "Can't connect Planner to Builder: they are already joined.",
  );
  expect(await files()).toEqual(["brief.md", "notes.md"]);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("file-wire-plan-build-notes.md")).toHaveText("notes.md");
  await expect(window.getByTestId("file-wire-plan-build-brief.md")).toHaveText("brief.md");
});

const zoomOf = async (window: Page) =>
  window
    .locator(".react-flow__viewport")
    .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);

test("The view fits a blueprint when it opens, and Cmd+= Cmd+- Cmd+0 zoom", async () => {
  seedFlow(
    home,
    flow([at(agent("near"), 0, 0), at(agent("far"), 1200, 1000)], [thenWire("near", "far")]),
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

test("A new blueprint with one Agent asks for its repository at Build, then runs", async () => {
  const repo = await tempRepo();
  const window = await launch();
  await window.getByTestId(paletteTestId("agent")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 300, y: 200 },
  });
  await window.getByTestId(paletteTestId("trigger")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 60, y: 200 },
  });
  await window.getByTestId(paletteTestId("output")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 560, y: 200 },
  });
  await connectPorts(
    window,
    window.getByTestId("port-trigger-1-out"),
    window.getByTestId("port-agent-1-in"),
  );
  await connectPorts(
    window,
    window.getByTestId("port-agent-1-out"),
    window.getByTestId("port-output-1-in"),
  );
  await window.getByTestId("node-agent-1").click();
  await window.getByTestId("node-setting-instructions").fill("Print the working folder.");
  await window.getByTestId("node-setting-instructions").blur();
  await window.getByTestId("node-output-1").click();
  await window.getByTestId("node-setting-name").fill("result");
  await window.getByTestId("node-setting-name").blur();
  await window.getByTestId("node-setting-type").fill("text");
  await window.getByTestId("node-setting-type").blur();

  await window.getByTestId(controlTestIds.build).click();

  await expect(window.getByTestId(buildDialogTestIds.repo)).toHaveValue("");
  await window.getByTestId(buildDialogTestIds.name).fill("pwd");
  await expect(window.getByTestId(buildDialogTestIds.confirm)).toBeDisabled();
  await window.getByTestId(buildDialogTestIds.cancel).click();
  await window.getByTestId(controlTestIds.sessionChip).click();
  await expect(window.getByTestId("session-settings")).toBeVisible();
  await window.getByTestId(buildConfigTestIds.repo).fill(repo.path);
  await window.getByTestId(buildConfigTestIds.repo).press("Enter");

  const buildId = await buildAndRun(window, home, "pwd");

  await expect(window.getByTestId("node-status-agent-1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  const app = launched;
  launched = undefined;
  await app?.close();
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    expect(db.prepare("SELECT node_id, finished_at FROM run_nodes ORDER BY node_id").all()).toEqual(
      [
        { node_id: "agent-1", finished_at: expect.any(String) },
        { node_id: "output-1", finished_at: expect.any(String) },
        { node_id: "trigger-1", finished_at: expect.any(String) },
      ],
    );
    const [session] = db.prepare("SELECT cwd FROM run_sessions").all() as { cwd: string }[];
    expect(await realpath(session?.cwd ?? "")).toBe(
      await realpath(join(home, "workspaces", buildId, basename(repo.path))),
    );
  } finally {
    db.close();
  }
});

test("The gear picks the model, permission mode and the repository's base branch", async () => {
  const repo = await tempRepo();
  await git(repo.path, "branch", "dev");
  seedFlow(home, flow([at(agent("s1"), 80, 120)], []), repo.path);
  const window = await launch("dark");

  await window.getByTestId(controlTestIds.sessionChip).click();
  await expect(window.getByTestId("session-settings")).toBeVisible();
  await expect(window.getByTestId("session-name")).toHaveValue("main");
  const basePick = window.getByTestId(buildConfigTestIds.base);
  await expect(basePick.locator("option")).toHaveText(["dev", "main"]);
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

  await basePick.selectOption("dev");
  await window.getByTestId("session-model").selectOption("haiku");
  await window.getByTestId("session-permission-mode").selectOption("acceptEdits");
  await expect
    .poll(async () => (await readout(window)).session)
    .toMatchObject({
      model: "haiku",
      permissionMode: "acceptEdits",
      buildConfig: { repo: repo.path, base: "dev" },
    });
  await expect(window.getByTestId("session-chip")).toContainText("Haiku (latest)");
});

const runInBuild = async (writes: Record<string, string> = {}) => {
  const repo = await tempRepo();
  seedFlow(home, onMainFlow([at(agent("s1"), 80, 120)], []), repo.path);
  const window = await launch(undefined, { s1: writes });
  const buildId = await buildAndRun(window, home, "wt");
  await expect(window.getByTestId("node-status-s1")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  const path = join(home, "workspaces", buildId, basename(repo.path));
  return { window, repo, path, branch: `flowdeck/wt-${buildId.slice(0, 8)}` };
};

const appLog = () => readFile(test.info().outputPath("app.log"), "utf8");

test("A finished run that changed nothing leaves its build's worktree and branch in place", async () => {
  const { repo, path, branch } = await runInBuild();

  expect(
    (await git(repo.path, "branch", "--list", "--format=%(refname:short)", "flowdeck/*")).trim(),
  ).toBe(branch);
  const worktrees = await git(repo.path, "worktree", "list", "--porcelain");
  expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
  expect(worktrees).toContain(`worktree ${await realpath(path)}`);
  expect(await appLog()).not.toMatch(/removed worktree/);
});

test("A run that wrote a file leaves it in its build's worktree, not the repo, and the Activity has no kept line", async () => {
  const { window, repo, path } = await runInBuild({ "made.txt": "made\n" });

  expect(await readFile(join(path, "made.txt"), "utf8")).toBe("made\n");
  await expect(stat(join(repo.path, "made.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await window.getByTestId("run-tab-activity").click();
  await expect(window.getByTestId("inspector-node-s1")).toHaveAttribute("data-status", "done");
  await expect(window.locator('[data-kind="kept"]')).toHaveCount(0);
});

const worktreeNote =
  "Every build makes its own git worktree from this branch. Flowdeck never works in the repository's own checkout.";

const withoutRepo = (drawn: Flow): Flow => ({
  ...drawn,
  session: { ...drawn.session, buildConfig: { variables: [] } },
});

const plainFolder = async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "fd-plain-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};

const stubFolderPicker = async (picked: string | null) => {
  await launched?.app.evaluate(({ dialog }, path) => {
    const reply =
      path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] };
    const asked: unknown[] = [];
    (globalThis as { folderPicks?: unknown[] }).folderPicks = asked;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return reply;
    }) as unknown as typeof dialog.showOpenDialog;
  }, picked);
};

const folderPicks = async () =>
  launched?.app.evaluate(() => (globalThis as { folderPicks?: unknown[] }).folderPicks ?? []);

test("Start from branch lists the repository's branches once one is set, and says why when it can't", async () => {
  const repo = await tempRepo();
  await git(repo.path, "branch", "dev");
  const plain = await plainFolder();
  seedFlow(home, withoutRepo(flow([at(agent("s1"), 80, 120)], [])));
  const window = await launch();
  await window.getByTestId(controlTestIds.sessionChip).click();
  await expect(window.getByTestId("session-settings")).toBeVisible();
  const repoField = window.getByTestId(buildConfigTestIds.repo);
  const basePick = window.getByTestId(buildConfigTestIds.base);

  await expect(basePick).toBeDisabled();
  await expect(basePick.locator("option")).toHaveText(["Choose a repository first"]);
  await expect(window.getByTestId(buildConfigTestIds.branchesError)).toHaveCount(0);

  await repoField.fill(repo.path);
  await repoField.press("Enter");
  await expect(basePick).toBeEnabled();
  await expect(basePick.locator("option")).toHaveText(["Choose…", "dev", "main"]);
  await basePick.selectOption("dev");
  await expect
    .poll(async () => (await readout(window)).session.buildConfig)
    .toEqual({ repo: repo.path, base: "dev", variables: [] });
  await window.getByTestId(controlTestIds.sessionSettings).click();
  await expect(window.getByTestId("session-settings")).toHaveCount(0);
  await window.getByTestId(controlTestIds.sessionSettings).click();
  await expect(basePick).toHaveValue("dev");

  await repoField.fill(plain);
  await repoField.press("Enter");
  await expect(window.getByTestId(buildConfigTestIds.branchesError)).toHaveText(
    `${plain} is not a git repository`,
  );
  await expect(basePick).toBeDisabled();
  await expect(basePick.locator("option")).toHaveText(["No branches"]);
  await expect
    .poll(async () => (await readout(window)).session.buildConfig)
    .toEqual({ repo: plain, variables: [] });
  await expect(window.locator("input[data-testid*='base']")).toHaveCount(0);

  const info = window.getByTestId(buildConfigTestIds.baseInfo);
  await expect(info).toHaveAttribute("title", worktreeNote);
  await expect(window.getByRole("img", { name: worktreeNote })).toBeVisible();
});

test("Browse fills Repository from the folder picker and loads its branches; cancelling changes nothing", async () => {
  const repo = await tempRepo();
  await git(repo.path, "branch", "dev");
  seedFlow(home, withoutRepo(flow([at(agent("s1"), 80, 120)], [])));
  const window = await launch();
  await window.getByTestId(controlTestIds.sessionChip).click();
  const repoField = window.getByTestId(buildConfigTestIds.repo);
  const basePick = window.getByTestId(buildConfigTestIds.base);
  const browse = window.getByTestId(buildConfigTestIds.repoBrowse);
  await expect(browse).toHaveAccessibleName("Browse for a folder");

  await stubFolderPicker(null);
  await browse.click();
  await expect.poll(folderPicks).toEqual([{ properties: ["openDirectory"] }]);
  await expect(repoField).toHaveValue("");
  await expect(basePick).toBeDisabled();
  expect((await readout(window)).session.buildConfig).toEqual({ variables: [] });

  await stubFolderPicker(repo.path);
  await browse.click();
  await expect(repoField).toHaveValue(repo.path);
  await expect(basePick).toBeEnabled();
  await expect(basePick.locator("option")).toHaveText(["Choose…", "dev", "main"]);
  await expect
    .poll(async () => (await readout(window)).session.buildConfig)
    .toEqual({ repo: repo.path, variables: [] });
});
