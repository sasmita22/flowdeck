import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteTitle } from "../src/app/renderer/canvas/palette-items.js";
import { controlTestIds, paletteTestId, readoutTestIds } from "../src/app/renderer/test-ids.js";
import { agent, flow, prompt, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let launched: LaunchedApp | undefined;

const launch = async () => {
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched;
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

type Readout = {
  nodes: { id: string }[];
  notes?: { id: string; text: string; size: { width: number; height: number } }[];
};

const readout = async (window: Page) =>
  JSON.parse((await window.getByTestId(readoutTestIds.flow).textContent()) ?? "") as Readout;

const noteIn = async (window: Page, id: string) =>
  (await readout(window)).notes?.find((note) => note.id === id);

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const doubleClick = async (window: Page, target: Locator) => {
  const box = await boxOf(target);
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.up();
  await window.waitForTimeout(100);
  await window.mouse.down({ clickCount: 2 });
  await window.mouse.up({ clickCount: 2 });
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-notes-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("A note is dropped, written in, resized, saved, reopened, deleted and undone", async () => {
  const { window } = await launch();

  await window.getByTestId(paletteTestId("note")).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: 260, y: 180 },
  });
  const note = window.getByTestId("note-n1");
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("title", noteTitle);
  await expect(note.locator(".react-flow__handle")).toHaveCount(0);

  await note.click();
  await expect(window.getByTestId("node-settings")).toHaveCount(0);
  await expect(window.getByTestId("inspector")).toHaveCount(0);

  await doubleClick(window, note);
  const text = window.getByTestId("note-text-n1");
  await expect(text).toBeFocused();
  await window.keyboard.type("Plan first,");
  await doubleClick(window, text);
  await expect(text).toBeFocused();
  await window.keyboard.press("End");
  await window.keyboard.type(" then build");
  await window.keyboard.press("Escape");
  await expect(text).toHaveText("Plan first, then build");
  await expect.poll(async () => (await noteIn(window, "n1"))?.text).toBe("Plan first, then build");

  await window.getByTestId(controlTestIds.undo).click();
  await expect.poll(async () => (await noteIn(window, "n1"))?.text).toBe("");
  await expect(text).toHaveText("Double-click to write");
  await window.getByTestId(controlTestIds.redo).click();
  await expect.poll(async () => (await noteIn(window, "n1"))?.text).toBe("Plan first, then build");
  await expect(text).toHaveText("Plan first, then build");

  const before = await boxOf(note);
  const corner = await boxOf(
    window.locator(".react-flow__node-note .react-flow__resize-control.handle.bottom.right"),
  );
  await window.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await window.mouse.down();
  await window.mouse.move(corner.x + 100, corner.y + 60, { steps: 8 });
  await window.mouse.up();
  const after = await boxOf(note);
  expect(after.width).toBeGreaterThan(before.width + 80);
  expect(after.height).toBeGreaterThan(before.height + 40);
  const resized = (await noteIn(window, "n1"))?.size;
  expect(resized?.width).toBeGreaterThan(300);

  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);

  const reopened = (await relaunch()).window;
  const back = reopened.getByTestId("note-n1");
  await expect(back).toBeVisible();
  await expect(reopened.getByTestId("note-text-n1")).toHaveText("Plan first, then build");
  expect((await noteIn(reopened, "n1"))?.size).toEqual(resized);
  const reopenedBox = await boxOf(back);
  expect(Math.round(reopenedBox.width)).toBe(Math.round(after.width));
  expect(Math.round(reopenedBox.height)).toBe(Math.round(after.height));

  await back.click();
  await reopened.getByTestId(controlTestIds.delete).click();
  await expect(back).toHaveCount(0);
  expect(await noteIn(reopened, "n1")).toBeUndefined();

  await reopened.getByTestId(controlTestIds.undo).click();
  await expect(back).toBeVisible();
  await expect(reopened.getByTestId("note-text-n1")).toHaveText("Plan first, then build");
});

test("The sidebar's Canvas group holds the Note, previewed left of its words", async () => {
  const { window } = await launch();
  const entry = window.getByTestId(paletteTestId("note"));
  await entry.scrollIntoViewIfNeeded();

  await expect(window.getByRole("heading", { name: "Canvas" })).toBeVisible();
  await expect(entry).toContainText("NOTE");
  await expect(entry).toContainText("Canvas-only text. It never runs.");
  const preview = await boxOf(entry.locator("svg"));
  const words = await boxOf(entry.locator(".fd-palette-description"));
  expect(preview.x + preview.width).toBeLessThanOrEqual(words.x);

  await window.emulateMedia({ colorScheme: null });
  const shot = test.info().outputPath("palette-note.png");
  await window.locator(".fd-sidebar").screenshot({ path: shot });
  await test.info().attach("palette-note.png", { path: shot, contentType: "image/png" });
});

test("A note sits beside the nodes, calm and readable, and never joins the session", async () => {
  seedFlow(home, {
    ...flow(
      [
        { ...prompt("plan"), label: "Write the plan", position: { x: 40, y: 60 } },
        { ...agent("build"), label: "Build it", position: { x: 260, y: 60 } },
        { ...script("test"), label: "npm test", position: { x: 480, y: 60 } },
      ],
      [thenWire("plan", "build"), thenWire("build", "test")],
    ),
    notes: [
      {
        id: "n1",
        text: "Plan first, then build.\nThe script checks the work.",
        position: { x: 40, y: 160 },
        size: { width: 260, height: 110 },
      },
    ],
  });
  const target = await launch();
  const { window } = target;
  await target.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
  });
  await window.waitForFunction(
    () => globalThis.innerWidth === 1280 && globalThis.innerHeight === 800,
  );
  await window.emulateMedia({ colorScheme: null });
  await window.evaluate(() => document.fonts.ready);
  await window.mouse.move(1, 1);
  await expect(window.getByTestId("note-text-n1")).toHaveText(
    "Plan first, then build.\nThe script checks the work.",
  );
  const shot = test.info().outputPath("note.png");
  await window.screenshot({ path: shot });
  await test.info().attach("note.png", { path: shot, contentType: "image/png" });

  await window.getByTestId("note-n1").click();
  await window.getByTestId("node-plan").click({ modifiers: ["Meta"] });
  await window.getByTestId(controlTestIds.wrap).click();
  await expect
    .poll(async () => {
      const current = (await readout(window)) as Readout & { session: { frame?: unknown } };
      return current.session.frame;
    })
    .toEqual({ nodes: ["plan"] });
});
