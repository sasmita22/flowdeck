import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, paletteTestId, readoutTestIds } from "../src/app/renderer/test-ids.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let launched: LaunchedApp | undefined;

const launch = async () => {
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched;
};

const reviewShot = async (window: Page, testInfo: TestInfo, name: string) => {
  const image = testInfo.outputPath(`${name}.png`);
  const aria = testInfo.outputPath(`${name}.aria.yml`);
  await window.screenshot({ path: image });
  await writeFile(aria, await window.locator("body").ariaSnapshot());
  await testInfo.attach(`${name}.png`, { path: image, contentType: "image/png" });
  await testInfo.attach(`${name}.aria.yml`, { path: aria, contentType: "text/yaml" });
};

const showAt1280 = async (target: LaunchedApp) => {
  const size = { width: 1280, height: 800 };
  await target.app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(next.width, next.height);
  }, size);
  await target.window.waitForFunction(
    (next) => window.innerWidth === next.width && window.innerHeight === next.height,
    size,
  );
  await target.window.emulateMedia({ colorScheme: null });
  await target.window.evaluate(() => document.fonts.ready);
  await target.window.mouse.move(1, 1);
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

const drop = async (window: Page, type: Parameters<typeof paletteTestId>[0], x: number) => {
  await window.getByTestId(paletteTestId(type)).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x, y: 150 },
  });
  await expect(window.getByTestId(`node-${type}-1`)).toBeVisible();
};

type Readout = { nodes: { id: string; label: string; settings: Record<string, unknown> }[] };

const nodeIn = async (window: Page, id: string) => {
  const flow = JSON.parse(
    (await window.getByTestId(readoutTestIds.flow).textContent()) ?? "",
  ) as Readout;
  return flow.nodes.find((node) => node.id === id);
};

const setText = async (field: Locator, value: string) => {
  await field.fill(value);
  await field.blur();
};

const doubleClick = async (window: Page, target: Locator) => {
  const box = await target.boundingBox();
  if (box === null) throw new Error("element has no box");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.up();
  // A zero-gap dblclick() on an unselected node lands its second click on the pane.
  await window.waitForTimeout(100);
  await window.mouse.down({ clickCount: 2 });
  await window.mouse.up({ clickCount: 2 });
};

const top = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box.y;
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-node-settings-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Clicking a Gate shows what it is and its settings, and edits are saved", async () => {
  const target = await launch();
  const { window } = target;
  await drop(window, "gate", 200);
  await expect(window.getByTestId("inspector")).toHaveCount(0);

  await window.getByTestId("node-gate-1").click();

  const panel = window.getByTestId("node-settings");
  await expect(panel).toBeVisible();
  await expect(window.getByTestId("node-type-tag")).toHaveText("GATE");
  await expect(window.getByTestId("node-type-name")).toHaveText("Gate");
  await expect(window.getByTestId("node-type-description")).toHaveText(
    "Pauses until you approve. A flag can switch it off.",
  );
  await expect(window.getByTestId("node-label")).toHaveValue("Gate");
  await expect(window.getByLabel("What to show you")).toHaveAttribute(
    "data-testid",
    "node-setting-shown",
  );
  await expect(window.getByLabel("Skip it in automatic runs")).not.toBeChecked();
  expect(await top(window.getByTestId("node-type-name"))).toBeLessThan(
    await top(window.getByTestId("node-label")),
  );
  expect(await top(window.getByTestId("node-label"))).toBeLessThan(
    await top(window.getByTestId("node-setting-shown")),
  );
  expect(
    await window.evaluate(() => ({
      inCanvas: document.activeElement?.closest('[data-testid="canvas"]') !== null,
      inInspector: document.querySelector(".fd-inspector")?.contains(document.activeElement),
    })),
  ).toEqual({ inCanvas: true, inInspector: false });

  await setText(window.getByTestId("node-label"), "Review gate");
  await setText(window.getByTestId("node-setting-shown"), "Check the plan");
  await window.getByTestId("node-setting-skippable").check();

  await expect(window.getByTestId("node-gate-1")).toContainText("Review gate");
  await expect
    .poll(() => nodeIn(window, "gate-1"))
    .toMatchObject({
      label: "Review gate",
      settings: { shown: "Check the plan", skippable: true },
    });

  await showAt1280(target);
  await reviewShot(window, test.info(), "node-settings-panel");

  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);

  const reopened = (await relaunch()).window;
  await expect
    .poll(() => nodeIn(reopened, "gate-1"))
    .toMatchObject({
      label: "Review gate",
      settings: { shown: "Check the plan", skippable: true },
    });
  await expect(reopened.getByTestId("inspector")).toHaveCount(0);

  await reopened.getByTestId("node-gate-1").click();
  await expect(reopened.getByTestId("node-setting-shown")).toHaveValue("Check the plan");
  await expect(reopened.getByTestId("node-setting-skippable")).toBeChecked();
  await reopened.getByTestId(controlTestIds.inspectorHide).click();
  await expect(reopened.getByTestId("inspector")).toHaveCount(0);
});

test("Double-clicking an unselected node opens the hidden inspector", async () => {
  const { window } = await launch();
  await drop(window, "gate", 200);
  await window.getByTestId("canvas").click({ position: { x: 40, y: 400 } });
  await expect(window.getByTestId("inspector")).toHaveCount(0);
  await expect(window.locator(".react-flow__node.selected")).toHaveCount(0);

  await doubleClick(window, window.getByTestId("node-gate-1"));

  await expect(window.getByTestId("node-settings")).toBeVisible();
  await expect(window.getByTestId("node-label")).toHaveValue("Gate");
});

test("With nothing selected the inspector shows the session", async () => {
  const { window } = await launch();
  await drop(window, "gate", 200);
  await window.getByTestId("node-gate-1").click();
  await expect(window.getByTestId("node-settings")).toBeVisible();

  await window.getByTestId("canvas").click({ position: { x: 40, y: 400 } });

  await expect(window.getByTestId("node-settings")).toHaveCount(0);
  await expect(window.getByTestId("session-settings")).toBeVisible();
});

test("A Branch's flag comes from the Trigger's flags", async () => {
  const { window } = await launch();
  await drop(window, "trigger", 120);
  await drop(window, "branch", 420);
  const branchIssue = window.getByTestId("node-issue-branch-1");
  await expect(branchIssue).toBeVisible();

  await window.getByTestId("node-trigger-1").click();
  await window.getByTestId("node-setting-flags-add").click();
  await expect(window.getByTestId("node-setting-flags-name-0")).toHaveValue("flag");
  await expect(branchIssue).toHaveCount(0);

  await setText(window.getByTestId("node-setting-flags-name-0"), "deep");
  await window.getByTestId("node-setting-flags-on-0").check();
  await expect(branchIssue).toBeVisible();
  await expect
    .poll(() => nodeIn(window, "trigger-1"))
    .toMatchObject({ settings: { flags: { deep: true } } });

  await window.getByTestId("node-branch-1").click();
  await setText(window.getByTestId("node-setting-flag"), "deep");

  await expect(branchIssue).toHaveCount(0);
  await expect.poll(() => nodeIn(window, "branch-1")).toMatchObject({ settings: { flag: "deep" } });
});

test("A Hard stop has no switch to turn it off", async () => {
  const { window } = await launch();
  await drop(window, "hardstop", 200);

  await window.getByTestId("node-hardstop-1").click();

  const panel = window.getByTestId("node-settings");
  await expect(window.getByTestId("node-setting-condition")).toBeVisible();
  await expect(window.getByTestId("node-setting-shown")).toBeVisible();
  await expect(panel.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(window.getByTestId("node-setting-enabled")).toHaveCount(0);
  await expect(window.getByTestId("node-setting-locked")).toHaveCount(0);
});

test("Undo reverts a settings edit, and a field shows the validator's reason", async () => {
  const { window } = await launch();
  await drop(window, "agent", 200);
  await window.getByTestId("node-agent-1").click();
  const instructions = window.getByTestId("node-setting-instructions");
  const reason = window.getByTestId("node-setting-instructions-issue");
  await expect(reason).toHaveCount(0);

  await setText(instructions, "");

  await expect(reason).toHaveText("Agent has no instructions.");
  await expect(window.getByTestId("node-issue-agent-1")).toHaveText("Agent has no instructions.");

  await window.getByTestId(controlTestIds.undo).click();

  await expect(instructions).toHaveValue("Describe the agent's task.");
  await expect(reason).toHaveCount(0);
  await expect(window.getByTestId("node-issue-agent-1")).toHaveCount(0);
  await expect
    .poll(() => nodeIn(window, "agent-1"))
    .toMatchObject({ settings: { instructions: "Describe the agent's task." } });

  await window.getByTestId(controlTestIds.redo).click();
  await expect(instructions).toHaveValue("");
});

test("A value the node can't take is refused with a reason", async () => {
  const { window } = await launch();
  await drop(window, "foreach", 200);
  await window.getByTestId("node-foreach-1").click();
  const file = window.getByTestId("node-setting-file");

  await setText(file, "/etc/items.txt");

  await expect(window.getByTestId("node-setting-file-issue")).toHaveText(
    "must be relative to the session folder",
  );
  await expect(file).toHaveValue("items.txt");
  await expect
    .poll(() => nodeIn(window, "foreach-1"))
    .toMatchObject({
      settings: { file: "items.txt" },
    });
});

test("A refused value's reason goes once Undo changes the field", async () => {
  const { window } = await launch();
  await drop(window, "foreach", 200);
  await window.getByTestId("node-foreach-1").click();
  const file = window.getByTestId("node-setting-file");
  const reason = window.getByTestId("node-setting-file-issue");
  await setText(file, "lists/items.txt");
  await setText(file, "/etc/items.txt");
  await expect(reason).toHaveText("must be relative to the session folder");

  await window.getByTestId(controlTestIds.undo).click();

  await expect(file).toHaveValue("items.txt");
  await expect(reason).toHaveCount(0);
});
