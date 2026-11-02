import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelWidthLimits } from "../src/app/renderer/shell-store.js";
import { controlTestIds } from "../src/app/renderer/test-ids.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let launched: LaunchedApp | undefined;

const launch = async () => {
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
  await window.getByTestId(controlTestIds.inspectorShow).click();
  await expect(window.getByTestId("inspector")).toBeVisible();
  return launched;
};

const relaunch = async () => {
  await launched?.close();
  launched = undefined;
  return launch();
};

const widthOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box.width;
};

const sidebar = (window: Page) => window.getByRole("complementary", { name: "Nodes" });
const inspector = (window: Page) => window.getByTestId("inspector");
const canvas = (window: Page) => window.getByTestId("canvas");

const widths = async (window: Page) => ({
  sidebar: await widthOf(sidebar(window)),
  inspector: await widthOf(inspector(window)),
  canvas: await widthOf(canvas(window)),
});

const dragHandle = async (window: Page, testId: string, dx: number) => {
  const box = await window.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} has no box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx, y, { steps: 10 });
  await window.mouse.up();
};

const viewportTransform = (window: Page) =>
  window
    .locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform);

test.beforeEach(async () => {
  launched = undefined;
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-resize-")));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Both handles are named separators that start at the default widths", async () => {
  const { window } = await launch();

  for (const [testId, name] of [
    [controlTestIds.sidebarResize, "Drag to resize the node sidebar"],
    [controlTestIds.inspectorResize, "Drag to resize the inspector"],
  ] as const) {
    const handle = window.getByRole("separator", { name });
    await expect(handle).toHaveAttribute("data-testid", testId);
    await expect(handle).toHaveAttribute("title", name);
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveCSS("cursor", "col-resize");
  }
  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.initial,
    inspector: panelWidthLimits.inspector.initial,
  });
});

test("Dragging a handle by 100 moves 100 between its panel and the canvas", async () => {
  const { window } = await launch();
  const before = await widths(window);
  const viewport = await viewportTransform(window);

  await dragHandle(window, controlTestIds.sidebarResize, 100);
  const afterSidebar = await widths(window);
  expect(afterSidebar.sidebar - before.sidebar).toBe(100);
  expect(afterSidebar.canvas - before.canvas).toBe(-100);
  expect(afterSidebar.inspector).toBe(before.inspector);

  await dragHandle(window, controlTestIds.inspectorResize, -100);
  const afterInspector = await widths(window);
  expect(afterInspector.inspector - afterSidebar.inspector).toBe(100);
  expect(afterInspector.canvas - afterSidebar.canvas).toBe(-100);
  expect(afterInspector.sidebar).toBe(afterSidebar.sidebar);

  expect(await viewportTransform(window)).toBe(viewport);
});

test("A drag that outruns the inspector over its text selects none of it", async () => {
  const { window } = await launch();
  await expect(inspector(window)).not.toBeEmpty();

  await dragHandle(window, controlTestIds.inspectorResize, 160);

  expect(await widthOf(inspector(window))).toBe(panelWidthLimits.inspector.min);
  expect(await window.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
});

test("Dragging far past the limit stops at the maximum and minimum", async () => {
  const { window } = await launch();

  await dragHandle(window, controlTestIds.sidebarResize, 600);
  await dragHandle(window, controlTestIds.inspectorResize, -600);
  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.max,
    inspector: panelWidthLimits.inspector.max,
  });

  await dragHandle(window, controlTestIds.sidebarResize, -600);
  await dragHandle(window, controlTestIds.inspectorResize, 600);
  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.min,
    inspector: panelWidthLimits.inspector.min,
  });
});

test("Double-clicking a handle resets its panel", async () => {
  const { window } = await launch();
  await dragHandle(window, controlTestIds.sidebarResize, 100);
  await dragHandle(window, controlTestIds.inspectorResize, -100);

  await window.getByTestId(controlTestIds.sidebarResize).dblclick();
  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.initial,
    inspector: panelWidthLimits.inspector.initial + 100,
  });

  await window.getByTestId(controlTestIds.inspectorResize).dblclick();
  expect(await widthOf(inspector(window))).toBe(panelWidthLimits.inspector.initial);
});

test("Hiding and showing a panel keeps its width", async () => {
  const { window } = await launch();
  await dragHandle(window, controlTestIds.sidebarResize, 100);
  await dragHandle(window, controlTestIds.inspectorResize, -100);

  await window.getByTestId(controlTestIds.sidebarHide).click();
  await window.getByTestId(controlTestIds.inspectorHide).click();
  await expect(window.getByTestId(controlTestIds.sidebarResize)).toHaveCount(0);
  await expect(window.getByTestId(controlTestIds.inspectorResize)).toHaveCount(0);
  await window.getByTestId(controlTestIds.sidebarShow).click();
  await window.getByTestId(controlTestIds.inspectorShow).click();

  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.initial + 100,
    inspector: panelWidthLimits.inspector.initial + 100,
  });
});

test("The widths survive a restart", async () => {
  const first = await launch();
  expect(await first.app.evaluate(({ app }) => app.getPath("userData"))).toBe(
    join(home, "user-data"),
  );
  await dragHandle(first.window, controlTestIds.sidebarResize, 100);
  await dragHandle(first.window, controlTestIds.inspectorResize, -100);

  const { window } = await relaunch();

  expect(await widths(window)).toMatchObject({
    sidebar: panelWidthLimits.sidebar.initial + 100,
    inspector: panelWidthLimits.inspector.initial + 100,
  });
});
