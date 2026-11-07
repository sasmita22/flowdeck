import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { flow, prompt } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { launchApp, launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-bp-"));
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
  return launched.window;
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

const idsAfter = (window: Page, prefix: string) =>
  window
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll(
      (elements, start) =>
        elements.map((element) => element.getAttribute("data-testid")?.slice(start) ?? ""),
      prefix.length,
    );

const cardOrder = (window: Page) => idsAfter(window, "blueprint-card-");

const recentOrder = (window: Page) => idsAfter(window, "menu-recent-");

const pinnedRows = () => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare("SELECT name, pinned FROM flows ORDER BY name").all();
  } finally {
    db.close();
  }
};

test("A fresh launch opens on the Blueprints page, not the canvas", async () => {
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const window = launched.window;

  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  await expect(window.getByTestId(pageTestIds.create)).toBeVisible();
  await expect(window.getByTestId(controlTestIds.save)).toHaveCount(0);
});

test("A pinned blueprint is first under both sorts and in Recent, after a relaunch too, and unpins from Recent", async () => {
  const zulu = seedBlueprint(home, "Zulu", flow([prompt("p1")], [])).flowId;
  const alpha = seedBlueprint(home, "Alpha", flow([prompt("p1")], [])).flowId;
  const mike = seedBlueprint(home, "Mike", flow([prompt("p1")], [])).flowId;
  let window = await launch();

  await window.getByTestId(controlTestIds.back).click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  await expect.poll(() => cardOrder(window)).toEqual([mike, alpha, zulu]);
  await expect.poll(() => recentOrder(window)).toEqual([mike, alpha, zulu]);

  const pinOnCard = window.getByTestId(`blueprint-pin-${zulu}`);
  await expect(pinOnCard).toBeVisible();
  await pinOnCard.click();

  await expect(pinOnCard).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => cardOrder(window)).toEqual([zulu, mike, alpha]);
  await window.getByTestId(pageTestIds.sort).selectOption("name");
  await expect.poll(() => cardOrder(window)).toEqual([zulu, alpha, mike]);

  window = await relaunch();
  await window.getByTestId(controlTestIds.back).click();
  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Blueprints");
  await expect.poll(() => cardOrder(window)).toEqual([zulu, mike, alpha]);
  await expect.poll(() => recentOrder(window)).toEqual([zulu, mike, alpha]);

  await window.getByTestId(`recent-pin-${zulu}`).click();

  await expect.poll(() => recentOrder(window)).toEqual([mike, alpha, zulu]);
  await expect.poll(() => cardOrder(window)).toEqual([mike, alpha, zulu]);
  await expect(window.getByTestId(`blueprint-pin-${zulu}`)).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const closing = launched;
  launched = undefined;
  await closing?.close();
  expect(pinnedRows()).toEqual([
    { name: "Alpha", pinned: 0 },
    { name: "Mike", pinned: 0 },
    { name: "Zulu", pinned: 0 },
  ]);
});
