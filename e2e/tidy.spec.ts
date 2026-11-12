import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow, fork, gate } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import {
  launchOnCanvas,
  playwrightPage,
  type ColorScheme,
  type LaunchedApp,
} from "../scripts/drive.js";
import { CANVAS_MIN } from "../src/app/renderer/shell-store.js";
import { controlTestIds } from "../src/app/renderer/test-ids.js";

let home: string;
let launched: LaunchedApp | undefined;

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const at = <N extends object>(node: N, x: number, y: number, label: string) => ({
  ...node,
  position: { x, y },
  label,
});

const tidyButton = (window: Page) => window.getByTestId("canvas-tidy");

const positions = (window: Page) =>
  window
    .locator(".react-flow__node")
    .evaluateAll((elements) =>
      Object.fromEntries(
        elements.map((element) => [
          element.getAttribute("data-id") ?? "",
          (element as HTMLElement).style.transform,
        ]),
      ),
    );

const overlapping = async (window: Page) => {
  const boxes = await Promise.all(
    (await window.locator(".react-flow__node").all()).map((node) => boxOf(node)),
  );
  return boxes.some((box, index) => boxes.slice(index + 1).some((other) => intersects(box, other)));
};

const launch = async (colorScheme?: ColorScheme) => {
  launched = await launchOnCanvas({
    home,
    logPath: test.info().outputPath("app.log"),
    ...(colorScheme === undefined ? {} : { colorScheme }),
  });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched.window;
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

const dragHandle = async (window: Page, testId: string, dx: number) => {
  const box = await boxOf(window.getByTestId(testId));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx, y, { steps: 10 });
  await window.mouse.up();
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-td-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Tidy moves overlapping nodes and marks the blueprint unsaved, and one Undo puts every node back", async () => {
  const window = await launch();
  const page = playwrightPage(window);
  for (let added = 0; added < 3; added++) {
    await page.drag("palette-agent", "canvas", { x: 200, y: 150 });
  }
  const nodes = window.locator(".react-flow__node");
  await expect(nodes).toHaveCount(3);
  const first = await boxOf(nodes.nth(0));
  const last = await boxOf(nodes.nth(2));
  await window.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await window.mouse.down();
  await window.mouse.move(first.x + first.width / 2 + 20, first.y + first.height / 2 + 10, {
    steps: 12,
  });
  await window.mouse.up();
  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);
  const before = await positions(window);
  expect(await overlapping(window)).toBe(true);

  await tidyButton(window).click();

  await expect.poll(() => positions(window)).not.toEqual(before);
  expect(await overlapping(window)).toBe(false);
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();

  await window.getByTestId(controlTestIds.undo).click();

  await expect.poll(() => positions(window)).toEqual(before);
});

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`The Tidy button sits bottom-right, named Tidy layout, clear of the zoom controls and the toast in the ${colorScheme} theme`, async () => {
    seedFlow(home, flow([at(fork("f1"), 80, 120, "Split"), at(gate("p1"), 300, 120, "Draft")], []));
    const window = await launch(colorScheme);
    const button = tidyButton(window);

    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("title", "Tidy layout");
    await expect(button).toHaveAccessibleName("Tidy layout");

    const canvas = await boxOf(window.getByTestId("canvas"));
    const tidy = await boxOf(button);
    expect(tidy.x + tidy.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    expect(tidy.y + tidy.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    expect(tidy.x).toBeGreaterThan(canvas.x + canvas.width / 2);
    expect(tidy.y).toBeGreaterThan(canvas.y + canvas.height / 2);
    expect(canvas.x + canvas.width - (tidy.x + tidy.width)).toBeLessThanOrEqual(48);
    expect(canvas.y + canvas.height - (tidy.y + tidy.height)).toBeLessThanOrEqual(48);

    expect(intersects(tidy, await boxOf(window.locator(".react-flow__controls")))).toBe(false);

    await connectPorts(window, window.getByTestId("port-f1-out"), window.getByTestId("port-p1-in"));
    const toast = window.getByTestId("canvas-message");
    await expect(toast).toBeVisible();
    expect(intersects(tidy, await boxOf(toast))).toBe(false);

    await window.mouse.move(1, 1);
    await expect.soft(window).toHaveScreenshot(`tidy-corner-${colorScheme}.png`, {
      threshold: 0,
      clip: {
        x: canvas.x + canvas.width / 2,
        y: tidy.y - 24,
        width: canvas.width / 2,
        height: canvas.y + canvas.height - (tidy.y - 24),
      },
    });
  });
}

test("On the narrowest canvas the toast stays readable and clear of the Tidy button and the zoom controls", async () => {
  seedFlow(home, flow([at(fork("f1"), 80, 120, "Split"), at(gate("p1"), 300, 120, "Draft")], []));
  const window = await launch();
  await connectPorts(window, window.getByTestId("port-f1-out"), window.getByTestId("port-p1-in"));
  const toast = window.getByTestId("canvas-message");
  await expect(toast).toBeVisible();

  await launched?.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(960, 640);
  });
  await window.waitForFunction(() => innerWidth === 960 && innerHeight === 640);
  await window.getByTestId(controlTestIds.inspectorShow).click();
  await dragHandle(window, controlTestIds.sidebarResize, 600);
  await dragHandle(window, controlTestIds.inspectorResize, -600);
  const canvas = await boxOf(window.getByTestId("canvas"));
  expect(canvas.width).toBeLessThanOrEqual(CANVAS_MIN + 2);

  await expect(toast).toBeVisible();
  const box = await boxOf(toast);
  expect(box.width).toBeGreaterThanOrEqual(240);
  expect(box.height).toBeLessThanOrEqual(80);
  expect(box.x).toBeGreaterThanOrEqual(canvas.x);
  expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width);
  expect(intersects(box, await boxOf(tidyButton(window)))).toBe(false);
  expect(intersects(box, await boxOf(window.locator(".react-flow__controls")))).toBe(false);
});

test("On an empty canvas the Tidy button is disabled and clear of the empty-canvas hint", async () => {
  const window = await launch();
  const button = tidyButton(window);
  const hint = window.getByTestId("canvas-empty-hint");

  await expect(hint).toBeVisible();
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  expect(intersects(await boxOf(button), await boxOf(hint))).toBe(false);
});
