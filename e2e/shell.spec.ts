import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildConfigTestIds,
  controlTestIds,
  paletteTestId,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import { NodeType, parseFlow } from "../src/core/flow/schema.js";
import {
  agent,
  flow,
  fork,
  join as joinNode,
  prompt,
  script,
  thenWire,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildAndRun } from "./build-run.js";

const git = (repo: string, ...args: string[]) => promisify(execFile)("git", ["-C", repo, ...args]);

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const darkBackground = "rgb(14, 17, 22)";
const shot = {
  size: { width: 1280, height: 800 },
  threshold: {
    threshold: 0,
    stylePath: fileURLToPath(new URL("./screenshot.css", import.meta.url)),
  },
};
const smallest = { width: 960, height: 640 };

const twoScripts = (firstCommand?: { command: string; args: string[] }) => {
  const seeded = JSON.parse(
    readFileSync(new URL("../test/fixtures/app-run-two-scripts.json", import.meta.url), "utf8"),
  ) as { nodes: { settings: object }[] };
  const [first] = seeded.nodes;
  if (first !== undefined && firstCommand !== undefined) first.settings = firstCommand;
  return seeded;
};

const launch = async () => {
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched;
};

const sizeTo = async (target: LaunchedApp, size: { width: number; height: number }) => {
  await target.app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(next.width, next.height);
  }, size);
  await target.window.waitForFunction(
    (next) => window.innerWidth === next.width && window.innerHeight === next.height,
    size,
  );
};

const showDark = async (target: LaunchedApp) => {
  await target.window.emulateMedia({ colorScheme: null });
  await sizeTo(target, shot.size);
  await target.window.evaluate(() => document.fonts.ready);
  await target.window.mouse.move(1, 1);
};

const drop = async (window: Page, testId: string, x: number, y: number) => {
  await window.getByTestId(testId).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x, y },
  });
};

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const wire = async (window: Page, from: string, to: string) => {
  const start = await boxOf(window.getByTestId(from));
  const end = await boxOf(window.getByTestId(to));
  await window.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await window.mouse.down();
  await window.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
  await window.mouse.up();
};

const titleAndCanvasControls = [
  controlTestIds.back,
  controlTestIds.title,
  controlTestIds.save,
  controlTestIds.build,
  controlTestIds.more,
  controlTestIds.sessionSettings,
  controlTestIds.undo,
  controlTestIds.redo,
  controlTestIds.delete,
  controlTestIds.sessionChip,
  controlTestIds.zoomIn,
  controlTestIds.zoomOut,
  controlTestIds.fit,
  controlTestIds.search,
  controlTestIds.sidebarHide,
  controlTestIds.inspectorShow,
];

const expectNamed = async (button: Locator, name: string) => {
  await expect(button).toHaveAttribute("title", name);
  await expect(button).toHaveAccessibleName(name);
};

const canvasWidth = async (window: Page) => (await boxOf(window.getByTestId("canvas"))).width;

const canvasControls = [
  controlTestIds.undo,
  controlTestIds.redo,
  controlTestIds.delete,
  controlTestIds.sessionChip,
  controlTestIds.zoomIn,
  controlTestIds.zoomOut,
  controlTestIds.fit,
];

const reviewShot = async (window: Page, testInfo: TestInfo, name: string) => {
  const image = testInfo.outputPath(`${name}.png`);
  const aria = testInfo.outputPath(`${name}.aria.yml`);
  await window.screenshot({ path: image });
  await writeFile(aria, await window.locator("body").ariaSnapshot());
  await testInfo.attach(`${name}.png`, { path: image, contentType: "image/png" });
  await testInfo.attach(`${name}.aria.yml`, { path: aria, contentType: "text/yaml" });
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-shell-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("Looks like the design", async () => {
  const target = await launch();
  const { window } = target;
  await showDark(target);
  await expect(window.getByTestId("canvas-empty-hint")).toBeVisible();

  await expect(window).toHaveScreenshot("shell-sidebar-open.png", shot.threshold);

  await window.getByTestId(controlTestIds.sidebarHide).click();
  await expect(window.getByTestId(controlTestIds.search)).toHaveCount(0);
  await window.mouse.move(1, 1);

  await expect(window).toHaveScreenshot("shell-sidebar-closed.png", shot.threshold);
});

test("Always dark", async () => {
  const { app, window } = await launch();

  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");

  await window.emulateMedia({ colorScheme: null });
  expect(await window.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    darkBackground,
  );
});

test("Readouts hidden, still readable", async () => {
  const { window } = await launch();

  for (const id of Object.values(readoutTestIds)) {
    const box = await boxOf(window.getByTestId(id));
    expect(box.width).toBeLessThanOrEqual(1);
    expect(box.height).toBeLessThanOrEqual(1);
  }

  await drop(window, paletteTestId("prompt"), 200, 150);

  await expect
    .poll(() => window.locator("body").ariaSnapshot())
    .toContain('\\"id\\":\\"prompt-1\\"');
});

test("Each sidebar entry previews its node's shape left of its name", async () => {
  const { window } = await launch();

  for (const type of NodeType.options) {
    const entry = window.getByTestId(paletteTestId(type));
    await entry.scrollIntoViewIfNeeded();
    const preview = entry.locator("svg");
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible();
    const shape = await boxOf(preview);
    const text = await boxOf(entry.locator(".fd-palette-description"));
    expect(shape.x + shape.width).toBeLessThanOrEqual(text.x);
  }
});

test("Controls keep their test ids", async () => {
  const target = await launch();
  const { window } = target;
  await sizeTo(target, shot.size);

  for (const type of NodeType.options) {
    await expect(window.getByTestId(paletteTestId(type))).toHaveCount(1);
    await expect(window.getByTestId(paletteTestId(type))).toBeVisible();
  }
  for (const id of titleAndCanvasControls) {
    await expect(window.getByTestId(id)).toHaveCount(1);
    await expect(window.getByTestId(id)).toBeVisible();
  }

  await window.getByTestId(controlTestIds.more).click();
  await expect(window.getByTestId(controlTestIds.terminalOpen)).toBeDisabled();
  await expect(window.getByRole("menuitem")).toHaveCount(1);
  await window.keyboard.press("Escape");

  await sizeTo(target, smallest);
  const scroll = await window.evaluate(() => {
    const page = document.scrollingElement ?? document.documentElement;
    return {
      down: page.scrollHeight - page.clientHeight,
      across: page.scrollWidth - page.clientWidth,
    };
  });
  expect(scroll).toEqual({ down: 0, across: 0 });

  const layout = await window.evaluate(() => {
    const rectOf = (testId: string, closest: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`)?.closest(closest);
      if (element === null || element === undefined) throw new Error(`no ${closest} for ${testId}`);
      const { top, bottom, right } = element.getBoundingClientRect();
      return { top, bottom, right };
    };
    return {
      title: rectOf("flow-title", "header"),
      canvas: rectOf("canvas", "div"),
      status: rectOf("run-status", "footer"),
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    };
  });
  expect(layout.canvas.top).toBeGreaterThanOrEqual(layout.title.bottom);
  expect(layout.canvas.bottom).toBeLessThanOrEqual(layout.status.top);
  expect(layout.status.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.canvas.right).toBeLessThanOrEqual(layout.width);
  expect(layout.status.right).toBeLessThanOrEqual(layout.width);
});

test("Every node type drops", async () => {
  const target = await launch();
  const { window } = target;
  await sizeTo(target, shot.size);

  for (const [index, type] of NodeType.options.entries()) {
    await drop(
      window,
      paletteTestId(type),
      60 + (index % 4) * 220,
      80 + Math.floor(index / 4) * 110,
    );
    if (index === 0) await expect(window.getByTestId("canvas-empty-hint")).toHaveCount(0);
  }

  const readout = (await window.getByTestId(readoutTestIds.flow).textContent()) ?? "";
  for (const type of NodeType.options) {
    expect(readout).toContain(`"id":"${type}-1"`);
    await expect(window.getByTestId(`node-${type}-1`)).toBeVisible();
  }
});

test("Sidebar search and toggle", async () => {
  const { window } = await launch();

  await window.getByTestId(controlTestIds.search).fill("loop");
  await expect(window.getByTestId(paletteTestId("loop"))).toBeVisible();
  await expect(window.getByTestId(paletteTestId("prompt"))).toHaveCount(0);

  await window.getByTestId(controlTestIds.sidebarHide).click();

  await expect(window.getByTestId(controlTestIds.search)).toHaveCount(0);
  await expect(window.getByTestId("canvas-empty-hint")).toHaveText(
    "Show the node sidebar with the button at the top left to start",
  );
});

test("Side panels hide and show from their own buttons", async () => {
  const target = await launch();
  const { window } = target;
  await sizeTo(target, shot.size);
  const sidebar = window.getByRole("complementary", { name: "Nodes" });
  const inspector = window.getByTestId("inspector");

  await expect(sidebar).toBeVisible();
  await expect(window.getByTestId(controlTestIds.sidebarShow)).toHaveCount(0);
  const withSidebar = await canvasWidth(window);
  await expectNamed(window.getByTestId(controlTestIds.sidebarHide), "Hide node sidebar");

  await window.getByTestId(controlTestIds.sidebarHide).click();
  await expect(sidebar).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.sidebarHide)).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.sidebarShow)).toBeVisible();
  expect(await canvasWidth(window)).toBeGreaterThan(withSidebar + 200);
  await expectNamed(window.getByTestId(controlTestIds.sidebarShow), "Show node sidebar");

  await window.getByTestId(controlTestIds.sidebarShow).click();
  await expect(sidebar).toBeVisible();
  await expect(window.getByTestId(controlTestIds.sidebarShow)).toHaveCount(0);
  expect(await canvasWidth(window)).toBe(withSidebar);

  await expect(inspector).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.inspectorHide)).toHaveCount(0);
  const withoutInspector = await canvasWidth(window);
  await expectNamed(window.getByTestId(controlTestIds.inspectorShow), "Show inspector");

  await window.getByTestId(controlTestIds.inspectorShow).click();
  await expect(inspector).toBeVisible();
  await expect(window.getByTestId(controlTestIds.inspectorShow)).toHaveCount(0);
  expect(await canvasWidth(window)).toBeLessThan(withoutInspector - 200);
  await expectNamed(window.getByTestId(controlTestIds.inspectorHide), "Hide inspector");

  await window.getByTestId(controlTestIds.inspectorHide).click();
  await expect(inspector).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.inspectorHide)).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.inspectorShow)).toBeVisible();
  expect(await canvasWidth(window)).toBe(withoutInspector);
});

test("Panel buttons hand focus to their counterpart", async () => {
  const { window } = await launch();

  for (const [from, to] of [
    [controlTestIds.sidebarHide, controlTestIds.sidebarShow],
    [controlTestIds.sidebarShow, controlTestIds.sidebarHide],
    [controlTestIds.inspectorShow, controlTestIds.inspectorHide],
    [controlTestIds.inspectorHide, controlTestIds.inspectorShow],
  ] as const) {
    await window.getByTestId(from).focus();
    await window.keyboard.press("Enter");
    await expect.soft(window.getByTestId(to)).toBeFocused();
  }
});

test("Panels appearing on their own leave focus alone", async () => {
  seedFlow(home, twoScripts(), repo.path);
  const { window } = await launch();

  await expect(window.getByTestId(controlTestIds.inspectorShow)).not.toBeFocused();

  await buildAndRun(window, home, "focus");
  await expect(window.getByTestId(controlTestIds.inspectorHide)).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId(controlTestIds.inspectorHide)).not.toBeFocused();
});

test("Toolbar keeps its height when the sidebar hides", async () => {
  const { window } = await launch();
  const undo = window.getByTestId(controlTestIds.undo);
  const withSidebar = (await boxOf(undo)).height;

  await window.getByTestId(controlTestIds.sidebarHide).click();
  await expect(window.getByTestId(controlTestIds.sidebarShow)).toBeVisible();

  expect((await boxOf(undo)).height).toBe(withSidebar);
});

test("Floating panel buttons leave the canvas controls clear", async () => {
  const testInfo = test.info();
  const target = await launch();
  const { window } = target;
  await showDark(target);

  await window.getByTestId(controlTestIds.sidebarHide).click();
  const sidebarShow = await boxOf(window.getByTestId(controlTestIds.sidebarShow));
  const inspectorShow = await boxOf(window.getByTestId(controlTestIds.inspectorShow));
  for (const id of canvasControls) {
    const control = await boxOf(window.getByTestId(id));
    expect(intersects(sidebarShow, control)).toBe(false);
    expect(intersects(inspectorShow, control)).toBe(false);
  }
  const canvas = await boxOf(window.getByTestId("canvas"));
  expect(sidebarShow.x).toBeLessThan(canvas.x + 24);
  expect(inspectorShow.x + inspectorShow.width).toBeGreaterThan(canvas.x + canvas.width - 24);

  await window.mouse.move(1, 1);
  await reviewShot(window, testInfo, "both-hidden");
});

test("Menu keyboard", async () => {
  const { window } = await launch();

  await window.getByTestId(controlTestIds.more).click();
  await expect(window.getByTestId(controlTestIds.terminalOpen)).toBeFocused();

  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu")).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.more)).toBeFocused();
});

test("Invalid node shows its reason", async () => {
  const { window } = await launch();
  const reason = "Has 0 branches; a parallel start needs two or more.";

  await drop(window, paletteTestId("fork"), 200, 150);
  await expect(window.getByTestId("node-issue-fork-1")).toBeVisible();
  await expect(window.getByTestId("node-issue-fork-1")).toHaveText(reason);
  await expect(window.getByTestId("node-issue-fork-1")).toHaveAttribute("title", reason);
  const bar = await boxOf(window.getByTestId("node-fork-1"));
  const label = await boxOf(
    window.getByTestId("node-fork-1").locator("text", { hasText: "PARALLEL START" }),
  );
  expect(label.y).toBeGreaterThanOrEqual(bar.y);
  expect(label.y + label.height).toBeLessThanOrEqual(bar.y + bar.height);
  const marker = await boxOf(window.getByTestId("node-issue-fork-1"));
  expect(marker.y).toBeGreaterThanOrEqual(bar.y + bar.height);

  await drop(window, paletteTestId("prompt"), 200, 300);
  await expect(window.getByTestId("node-prompt-1")).toBeVisible();
  await expect(window.getByTestId("node-issue-prompt-1")).toHaveText(
    "Write what the prompt should do.",
  );
});

test("Left to right, no overlap", async () => {
  const { window } = await launch();

  await drop(window, paletteTestId("prompt"), 200, 150);
  await drop(window, paletteTestId("prompt"), 200, 150);
  const first = await boxOf(window.getByTestId("node-prompt-1"));
  const second = await boxOf(window.getByTestId("node-prompt-2"));
  expect(intersects(first, second)).toBe(false);

  await window.getByTestId("node-prompt-1").click();
  await window.getByTestId(paletteTestId("script")).focus();
  await window.keyboard.press("Enter");
  const next = await boxOf(window.getByTestId("node-script-1"));
  expect(next.x).toBeGreaterThanOrEqual(first.x + first.width);
  expect(Math.abs(next.y - first.y)).toBeLessThan(2);

  await wire(window, "port-prompt-1-out", "port-script-1-in");
  const edge = window.locator(".react-flow__edge-path");
  await expect(edge).toHaveCount(1);
  await expect(edge).toHaveAttribute("marker-end", /url\(/);
});

test("Wires around a parallel section keep their arrowheads", async () => {
  seedFlow(
    home,
    flow(
      [
        { ...fork("fork"), position: { x: 0, y: 0 } },
        { ...agent("b1"), position: { x: 80, y: 0 } },
        { ...agent("b2"), position: { x: 80, y: 90 } },
        { ...joinNode("join"), position: { x: 320, y: 0 } },
      ],
      [
        thenWire("fork", "b1"),
        thenWire("fork", "b2"),
        thenWire("b1", "join"),
        thenWire("b2", "join"),
      ],
    ),
  );
  const { window } = await launch();

  const edges = window.locator(".react-flow__edge-path");
  await expect(edges).toHaveCount(4);
  for (const edge of await edges.all()) {
    await expect(edge).toHaveAttribute("marker-end", /url\(/);
  }
});

test("Review shots", async () => {
  const testInfo = test.info();
  seedFlow(
    home,
    flow(
      [
        { ...prompt("prompt-1"), label: "Prompt", position: { x: 80, y: 80 } },
        { ...script("script-1"), label: "Script", position: { x: 298, y: 80 } },
      ],
      [thenWire("prompt-1", "script-1")],
    ),
  );
  let target = await launch();
  await showDark(target);
  await reviewShot(target.window, testInfo, "small-flow");
  await target.close();

  await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "fd-shell-"));
  target = await launch();
  const { window } = target;
  await showDark(target);
  await reviewShot(window, testInfo, "empty-canvas");

  await window.getByTestId(controlTestIds.search).fill("people");
  await window.mouse.move(1, 1);
  await reviewShot(window, testInfo, "palette-open");
  await window.getByTestId(controlTestIds.search).fill("");

  await window.getByTestId(controlTestIds.more).click();
  await reviewShot(window, testInfo, "menu-open");
  await window.keyboard.press("Escape");
  await target.close();

  await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), "fd-shell-"));
  seedFlow(home, twoScripts({ command: "sleep", args: ["5"] }), repo.path);
  target = await launch();
  await showDark(target);
  await buildAndRun(target.window, home, "running");
  await expect(target.window.getByTestId("run-status")).toHaveText(/^Running/, {
    timeout: 20_000,
  });
  await expect(target.window.getByTestId("node-status-s1")).toHaveAttribute(
    "data-status",
    "running",
  );
  await target.window.mouse.move(1, 1);
  await reviewShot(target.window, testInfo, "running-flow");
  await expect(target.window.getByTestId("run-status")).toHaveText(/^Done/, { timeout: 20_000 });

  expect(testInfo.attachments.map(({ name }) => name).sort()).toEqual(
    ["empty-canvas", "menu-open", "palette-open", "running-flow", "small-flow"]
      .flatMap((name) => [`${name}.aria.yml`, `${name}.png`])
      .sort(),
  );
});

test("Run status and inspector", async () => {
  seedFlow(home, twoScripts(), repo.path);
  const { window } = await launch();

  await expect(window.getByTestId("run-status")).toHaveText("Idle");
  await expect(window.getByTestId("inspector")).toHaveCount(0);

  await buildAndRun(window, home, "status");
  await expect(window.getByTestId("node-status-s2")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });

  await expect(window.getByTestId("run-status")).toHaveText("Done · 2 of 2 nodes done");
  await expect(window.getByTestId("inspector")).toBeVisible();
});

test("Branch shown", async () => {
  await git(repo.path, "checkout", "--quiet", "-b", "fd-demo");
  await git(repo.path, "branch", "fd-next");
  const seeded = parseFlow(twoScripts());
  seedFlow(home, {
    ...seeded,
    session: { ...seeded.session, buildConfig: { repo: repo.path, variables: [] } },
  });
  const { window } = await launch();

  await expect(window.getByTestId("workspace-folder")).toHaveText(basename(repo.path));
  await expect(window.getByTestId("workspace-folder")).toHaveAttribute("title", repo.path);
  await expect(window.getByTestId("workspace-branch")).toHaveText("fd-demo");
  await expect(window.getByTestId("workspace-branch")).toHaveAttribute("title", "fd-demo");

  await window.getByTestId(controlTestIds.sessionSettings).click();
  const base = window.getByTestId(buildConfigTestIds.base);
  await expect(base.locator("option", { hasText: "fd-next" })).toHaveCount(1);
  await base.selectOption("fd-next");

  await expect(window.getByTestId("workspace-branch")).toHaveText("fd-next");
});

test("A blueprint's base branch shows in the status bar", async () => {
  await git(repo.path, "checkout", "--quiet", "-b", "dev");
  seedFlow(home, flow([prompt("prompt-1")], []), repo.path);
  const { window } = await launch();

  await expect(window.getByTestId("workspace-folder")).toHaveText(basename(repo.path));
  await expect(window.getByTestId("workspace-branch")).toHaveText("main");
});
