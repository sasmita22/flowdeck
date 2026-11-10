import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, paletteTestId } from "../src/app/renderer/test-ids.js";
import { agent, flow, loop } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";

const long = "Review every changed file against the plan and list each gap";

let home: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-nw-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const launch = async () => {
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  await launched.window.evaluate(() => document.fonts.ready);
  return launched.window;
};

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("expected a visible element");
  return box;
};

const inside = (
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
) => ({
  left: inner.x >= outer.x,
  top: inner.y >= outer.y,
  right: inner.x + inner.width <= outer.x + outer.width,
  bottom: inner.y + inner.height <= outer.y + outer.height,
});

const everywhere = { left: true, top: true, right: true, bottom: true };

const labelOf = (window: Page, nodeId: string, text: string) =>
  window.getByTestId(`node-${nodeId}`).locator("svg text", { hasText: text });

test("An Agent renamed to 60 characters shows the whole label inside its outline", async () => {
  const window = await launch();
  await window.getByTestId(paletteTestId("agent")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 200, y: 200 },
  });
  const node = window.getByTestId("node-agent-1");
  await node.click();
  await node.dblclick();
  const field = window.getByTestId("node-rename");
  await field.fill(long);
  await field.press("Enter");
  await expect(field).toHaveCount(0);

  const label = labelOf(window, "agent-1", long);
  await expect(label).toHaveText(long);

  expect
    .soft(inside(await boxOf(label), await boxOf(node.locator(".fd-node-outline"))))
    .toEqual(everywhere);

  const fileOut = await window.getByTestId("port-agent-1-file-out").evaluate((handle) => ({
    left: parseFloat((handle as HTMLElement).style.left),
    nodeWidth: (handle.closest("[data-testid='node-agent-1']") as HTMLElement).offsetWidth,
  }));
  expect(fileOut.left).toBeGreaterThan(146);
  expect(fileOut.left).toBe(fileOut.nodeWidth - 24);
});

test("A Loop around a 60-character Agent grows to enclose it", async () => {
  seedFlow(
    home,
    flow(
      [
        { ...loop("L"), position: { x: 60, y: 60 } },
        { ...agent("A", { parent: "L" }), label: long, position: { x: 60, y: 150 } },
      ],
      [],
    ),
  );
  const window = await launch();
  const frame = await boxOf(window.getByTestId("loop-frame-L"));

  expect(inside(await boxOf(window.getByTestId("node-A")), frame)).toEqual(everywhere);
  expect(inside(await boxOf(labelOf(window, "A", long)), frame)).toEqual(everywhere);
});

test("A short-label Agent stays 170 wide", async () => {
  seedFlow(home, flow([{ ...agent("A"), label: "Review", position: { x: 60, y: 60 } }], []));
  const window = await launch();

  expect((await boxOf(window.getByTestId("node-A"))).width).toBe(170);
});

test("A 25-character Agent label sits inside its node", async () => {
  const mid = long.slice(0, 25);
  seedFlow(home, flow([{ ...agent("A"), label: mid, position: { x: 60, y: 60 } }], []));
  const window = await launch();

  const outline = await boxOf(window.getByTestId("node-A").locator(".fd-node-outline"));
  expect(inside(await boxOf(labelOf(window, "A", mid)), outline)).toEqual(everywhere);
});

test("A Loop with a 40-character title keeps it inside the node", async () => {
  const title = long.slice(0, 40);
  seedFlow(home, flow([{ ...loop("L"), label: title, position: { x: 60, y: 60 } }], []));
  const window = await launch();

  const node = window.getByTestId("node-L");
  const text = node.locator("svg text", { hasText: title });
  await expect(text).toHaveCount(1);
  const titleBox = await text.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { left, right } = range.getBoundingClientRect();
    return { left, right };
  });
  const outline = await boxOf(node.locator(".fd-node-outline"));

  const leftGap = titleBox.left - outline.x;
  const rightGap = outline.x + outline.width - titleBox.right;
  expect(leftGap).toBeGreaterThanOrEqual(0);
  expect(rightGap, `left gap ${leftGap}, right gap ${rightGap}`).toBeGreaterThanOrEqual(
    leftGap - 1,
  );
});
