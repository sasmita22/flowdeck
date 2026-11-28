import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProducesAddTestId,
  branchVariableExistingTestId,
  branchVariableTestId,
  containerTestIds,
  controlTestIds,
  paletteTestId,
  produceRowTestIds,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import { bareFlow, branch, thenWire, trigger, wire } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";
import { endSessionsOfHome } from "./own-sessions.js";

const sessionRepo = containerTestIds.field("session-1", "repo");

let home: string;
let launched: LaunchedApp | undefined;

const launch = async () => {
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
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
    await endSessionsOfHome(home);
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
    "Pauses the run to show you its Instruction: Always in every manual run, Conditional only when an agent finds its condition met.",
  );
  await expect(window.getByTestId("node-label")).toHaveValue("Gate");
  await expect(window.getByLabel("Condition to stop")).toHaveAttribute(
    "data-testid",
    "node-setting-stop-when",
  );
  await expect(window.getByTestId("node-setting-stop-when")).toHaveValue("always");
  await expect(window.getByLabel("Instruction", { exact: true })).toHaveAttribute(
    "data-testid",
    "node-setting-instruction",
  );
  await expect(window.getByTestId("node-setting-condition")).toHaveCount(0);
  await expect(window.getByTestId("node-settings-warning")).toBeVisible();
  await expect(window.getByTestId("node-gate-1").getByTestId("node-warning")).toBeVisible();
  expect(await top(window.getByTestId("node-type-name"))).toBeLessThan(
    await top(window.getByTestId("node-label")),
  );
  expect(await top(window.getByTestId("node-label"))).toBeLessThan(
    await top(window.getByTestId("node-setting-stop-when")),
  );
  expect(
    await window.evaluate(() => ({
      inCanvas: document.activeElement?.closest('[data-testid="canvas"]') !== null,
      inInspector: document.querySelector(".fd-inspector")?.contains(document.activeElement),
    })),
  ).toEqual({ inCanvas: true, inInspector: false });

  await setText(window.getByTestId("node-label"), "Review gate");
  await setText(window.getByTestId("node-setting-instruction"), "Check the plan");
  await window.getByTestId("node-setting-stop-when").selectOption("conditional");
  await expect(window.getByTestId("node-settings-warning")).toHaveCount(0);
  await expect(window.getByTestId("node-gate-1").getByTestId("node-warning")).toHaveCount(0);
  await setText(window.getByTestId("node-setting-condition"), "tests fail");

  await expect(window.getByTestId("node-gate-1")).toContainText("Review gate");
  await expect
    .poll(() => nodeIn(window, "gate-1"))
    .toMatchObject({
      label: "Review gate",
      settings: { stopWhen: "conditional", condition: "tests fail", instruction: "Check the plan" },
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
      settings: { stopWhen: "conditional", condition: "tests fail", instruction: "Check the plan" },
    });
  await expect(reopened.getByTestId("inspector")).toHaveCount(0);

  await reopened.getByTestId("node-gate-1").click();
  await expect(reopened.getByTestId("node-setting-stop-when")).toHaveValue("conditional");
  await expect(reopened.getByTestId("node-setting-condition")).toHaveValue("tests fail");
  await expect(reopened.getByTestId("node-setting-instruction")).toHaveValue("Check the plan");
  await reopened.getByTestId(controlTestIds.inspectorHide).click();
  await expect(reopened.getByTestId("inspector")).toHaveCount(0);
});

test("The sidebar, inspector and status bar draw text at the type scale's body size", async () => {
  const { window } = await launch();
  await drop(window, "gate", 200);
  await window.getByTestId("node-gate-1").click();
  const fontSize = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).fontSize);

  const body = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--fs-sm").trim(),
  );

  expect(body).toBe("13px");
  expect({
    description: await fontSize(
      window.getByTestId(paletteTestId("gate")).locator(".fd-palette-description"),
    ),
    label: await fontSize(window.locator("label", { hasText: "Instruction" })),
    status: await fontSize(window.getByTestId("run-status")),
  }).toEqual({ description: body, label: body, status: body });
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

test("With nothing selected the inspector shows the run, not the session settings", async () => {
  const { window } = await launch();
  await drop(window, "gate", 200);
  await window.getByTestId("node-gate-1").click();
  await expect(window.getByTestId("node-settings")).toBeVisible();

  await window.getByTestId("canvas").click({ position: { x: 40, y: 400 } });

  await expect(window.getByTestId("node-settings")).toHaveCount(0);
  await expect(window.getByTestId("inspector-session")).toBeVisible();
  await expect(window.getByTestId("inspector-node-gate-1")).toBeVisible();
  await expect(window.getByTestId(controlTestIds.blueprintSettings)).toHaveCount(0);
});

test("Blueprint settings open from the gear and never mix with a node's or a container's settings", async () => {
  const target = await launch();
  const { window } = target;
  const gear = window.getByTestId(controlTestIds.sessionSettings);
  const blueprintFields = window.getByTestId(controlTestIds.blueprintSettings);
  await drop(window, "gate", 200);
  await expect(window.getByTestId("inspector")).toHaveCount(0);

  await window.getByTestId("node-gate-1").click();
  await expect(window.getByTestId("node-setting-instruction")).toBeVisible();
  await expect(blueprintFields).toHaveCount(0);
  await expect(window.getByTestId(sessionRepo)).toHaveCount(0);
  await expect(window.getByTestId("settings-build-model")).toHaveCount(0);
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  await showAt1280(target);
  await reviewShot(window, test.info(), "gate-selected");

  await gear.click();
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await expect(window.getByTestId("node-settings")).toHaveCount(0);
  await expect(blueprintFields).toBeVisible();
  await expect(window.getByTestId("settings-build-model")).toBeVisible();
  await expect(window.getByTestId(sessionRepo)).toHaveCount(0);
  await expect(window.locator(".react-flow__node.selected")).toHaveCount(0);
  await window.mouse.move(1, 1);
  await reviewShot(window, test.info(), "session-settings-open");

  await window.getByTestId("settings-build-model").selectOption("claude-haiku-4-5");
  await expect
    .poll(async () => {
      const flow = JSON.parse(
        (await window.getByTestId(readoutTestIds.flow).textContent()) ?? "",
      ) as { settings: { buildModel: string } };
      return flow.settings.buildModel;
    })
    .toBe("claude-haiku-4-5");

  await window.getByTestId("node-gate-1").click();
  await expect(window.getByTestId("node-setting-instruction")).toBeVisible();
  await expect(blueprintFields).toHaveCount(0);
  await expect(gear).toHaveAttribute("aria-pressed", "false");

  await gear.click();
  await expect(blueprintFields).toBeVisible();
  await gear.click();
  await expect(blueprintFields).toHaveCount(0);
  await expect(window.getByTestId("inspector-session")).toBeVisible();

  await gear.click();
  await window.getByTestId("canvas").click({ position: { x: 40, y: 400 } });
  await expect(blueprintFields).toHaveCount(0);
  await expect(gear).toHaveAttribute("aria-pressed", "false");

  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);
  const reopened = (await relaunch()).window;
  await reopened.getByTestId(controlTestIds.sessionSettings).click();
  await expect(reopened.getByTestId("settings-build-model")).toHaveValue("claude-haiku-4-5");
});

test("A Branch's variable is a name typed into it, with no use existing list while no other Branch has one", async () => {
  seedFlow(home, bareFlow());
  const { window } = await launch();
  await drop(window, "trigger", 120);
  await drop(window, "branch", 420);
  await connectPorts(
    window,
    window.getByTestId("port-trigger-1-out"),
    window.getByTestId("port-branch-1-in"),
  );
  const branchIssue = window.getByTestId("node-issue-branch-1");
  await expect(branchIssue).toBeVisible();
  await window.getByTestId("node-branch-1").click();
  await expect(window.getByTestId("branch-no-variables")).toHaveCount(0);

  const variable = window.getByTestId(branchVariableTestId);
  expect(await variable.evaluate((element) => element.tagName)).toBe("INPUT");
  await setText(variable, "deep");

  await expect(branchIssue).toHaveCount(0);
  await expect
    .poll(() => nodeIn(window, "branch-1"))
    .toMatchObject({ settings: { variable: "deep" } });
  await expect(window.getByTestId(branchVariableExistingTestId)).toHaveCount(0);
});

const placed = <T extends { position: { x: number; y: number } }>(node: T, x: number): T => ({
  ...node,
  position: { x, y: 150 },
});

test("A second Branch typing a used variable is refused, and picking it from use existing shares it", async () => {
  seedFlow(
    home,
    bareFlow(
      [
        placed(trigger("t"), 80),
        placed(branch("first", "approved"), 320),
        placed(branch("second", ""), 600),
      ],
      [
        thenWire("t", "first"),
        wire("first", "yes", "second", "in"),
        wire("first", "no", "second", "in"),
      ],
    ),
  );
  const { window } = await launch();
  await window.getByTestId("node-second").click();
  const variable = window.getByTestId(branchVariableTestId);

  await setText(variable, "approved");

  await expect(window.getByTestId(`${branchVariableTestId}-issue`)).toBeVisible();
  await expect(window.getByTestId("node-issue-second")).toBeVisible();
  await expect(window.getByTestId("node-issue-first")).toHaveCount(0);

  await window.getByTestId(branchVariableExistingTestId).selectOption("approved");

  await expect(window.getByTestId("node-issue-second")).toHaveCount(0);
  await expect
    .poll(() => nodeIn(window, "second"))
    .toMatchObject({ settings: { variable: "approved", shared: true } });
});

test("Cmd+Z in a settings field undoes the typing and leaves the canvas alone", async () => {
  const { window } = await launch();
  await drop(window, "gate", 200);
  await window.getByTestId("node-gate-1").click();
  const instruction = window.getByLabel("Instruction", { exact: true });
  const before = await nodeIn(window, "gate-1");

  await instruction.click();
  await window.keyboard.type("Check the plan");
  await expect(instruction).toHaveValue("Check the plan");
  await window.keyboard.press("ControlOrMeta+z");

  await expect(instruction).toHaveValue("");
  await expect(instruction).toBeFocused();
  await expect(window.getByTestId("node-gate-1")).toBeVisible();
  await expect(window.getByTestId(controlTestIds.redo)).toBeDisabled();
  expect(await nodeIn(window, "gate-1")).toEqual(before);

  await window.keyboard.type("ab");
  await window.keyboard.press("Backspace");
  await expect(instruction).toHaveValue("a");
  await expect(window.getByTestId("node-gate-1")).toBeVisible();
  await expect(window.getByTestId(controlTestIds.redo)).toBeDisabled();
});

test("Undo reverts a settings edit, and a field shows the validator's reason", async () => {
  seedFlow(home, bareFlow());
  const { window } = await launch();
  await drop(window, "agent", 200);
  await window.getByTestId("node-agent-1").click();
  const instructions = window.getByTestId("node-setting-instructions");
  const reason = window.getByTestId("node-setting-instructions-issue");
  await expect(reason).toHaveText("Write what the agent should do.");

  await setText(instructions, "Review the plan.");

  await expect(reason).toHaveCount(0);
  await expect(window.getByTestId("node-issue-agent-1")).toHaveCount(0);

  await window.getByTestId(controlTestIds.undo).click();

  await expect(instructions).toHaveValue("");
  await expect(reason).toHaveText("Write what the agent should do.");
  await expect(window.getByTestId("node-issue-agent-1")).toHaveText(
    "Write what the agent should do.",
  );
  await expect
    .poll(() => nodeIn(window, "agent-1"))
    .toMatchObject({ settings: { instructions: "" } });

  await window.getByTestId(controlTestIds.redo).click();
  await expect(instructions).toHaveValue("Review the plan.");
});

const verdictNameReason = `"done" is the name a Loop's verdict uses; give the value another name`;

const branchesNamed = (...variables: string[]) =>
  bareFlow(
    [
      placed(trigger("t"), 80),
      ...variables.map((variable, index) =>
        placed(branch(`b${index}`, variable), 500 + index * 200),
      ),
    ],
    [
      thenWire("t", "b0"),
      ...variables
        .slice(1)
        .flatMap((_, index) => [
          wire(`b${index}`, "yes", `b${index + 1}`, "in"),
          wire(`b${index}`, "no", `b${index + 1}`, "in"),
        ]),
    ],
  );

const withProduceRow = async (window: Page) => {
  await drop(window, "agent", 250);
  await window.getByTestId("node-agent-1").click();
  await window.getByTestId(agentProducesAddTestId).click();
  return window.getByTestId(produceRowTestIds.variable(0));
};

test("A value the node can't take is refused with a reason", async () => {
  seedFlow(home, branchesNamed("done"));
  const { window } = await launch();
  const variable = await withProduceRow(window);

  await variable.selectOption("done");

  await expect(window.getByTestId(`${produceRowTestIds.variable(0)}-issue`)).toHaveText(
    verdictNameReason,
  );
  await expect(variable).toHaveValue("");
  await expect
    .poll(async () => (await nodeIn(window, "agent-1"))?.settings)
    .toMatchObject({ produces: [{ variable: "", yesIf: "", noIf: "" }] });
});

test("A refused value's reason goes once Undo changes the field", async () => {
  seedFlow(home, branchesNamed("tests-passed", "done"));
  const { window } = await launch();
  const variable = await withProduceRow(window);
  const reason = window.getByTestId(`${produceRowTestIds.variable(0)}-issue`);
  await variable.selectOption("tests-passed");
  await variable.selectOption("done");
  await expect(reason).toHaveText(verdictNameReason);

  await window.getByTestId(controlTestIds.undo).click();

  await expect(variable).toHaveValue("");
  await expect(reason).toHaveCount(0);
});
