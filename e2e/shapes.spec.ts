import { expect, test, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agent,
  ask,
  branch,
  flow,
  forEach,
  fork,
  gate,
  hardstop,
  join as joinNode,
  loop,
  output,
  prompt,
  script,
  thenWire,
  trigger,
  wire,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type ColorScheme, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let logDir: string;
let launched: LaunchedApp | undefined;

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const everyShape = () => {
  const seeded = flow(
    [
      at(trigger("trigger"), 10, 10),
      at(prompt("prompt"), 190, 10),
      at(agent("agent"), 10, 80),
      at(script("script"), 190, 80),
      at(gate("gate"), 10, 150),
      at(hardstop("hardstop"), 190, 150),
      at(ask("ask"), 10, 220),
      at(output("output"), 190, 220),
      at(loop("loop"), 60, 360),
      at(prompt("body", { parent: "loop" }), 60, 450),
    ],
    [],
  );
  return { ...seeded, session: { ...seeded.session, frame: { nodes: ["loop"] } } };
};

const parallelShapes = () =>
  flow(
    [
      at(fork("fork"), 10, 10),
      at(agent("b1"), 70, 10),
      at(agent("b2"), 70, 90),
      at(agent("b3"), 70, 170),
      at(joinNode("join"), 270, 10),
    ],
    [
      thenWire("fork", "b1"),
      thenWire("fork", "b2"),
      thenWire("fork", "b3"),
      thenWire("b1", "join"),
      thenWire("b2", "join"),
      thenWire("b3", "join"),
    ],
  );

const forEachShapes = () =>
  flow(
    [
      at(forEach("each"), 40, 40),
      at(prompt("first", { parent: "each" }), 40, 130),
      at(prompt("second", { parent: "each" }), 40, 200),
    ],
    [thenWire("first", "second")],
  );

const branchShapes = () =>
  flow(
    [
      at(trigger("trigger", { settings: { flags: { e2e: true } } }), 10, 10),
      at({ ...branch("branch", "e2e"), label: "E2E?" }, 220, 10),
      at(script("yes"), 400, 10),
      at(script("no"), 220, 120),
    ],
    [
      thenWire("trigger", "branch"),
      wire("branch", "yes", "yes", "in"),
      wire("branch", "no", "no", "in"),
    ],
  );

const pointsOf = async (polygon: Locator) =>
  ((await polygon.getAttribute("points")) ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);

const exact = { threshold: 0 };

const nodeShots = ["trigger", "prompt", "agent", "script", "gate", "hardstop", "ask", "output"];

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-sh-"));
  logDir = await mkdtemp(join(tmpdir(), "fd-sh-log-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Every node type draws its own shape in the ${colorScheme} theme`, async () => {
    seedFlow(home, everyShape());
    launched = await launchApp({ home, logPath: join(logDir, "app.log"), colorScheme });
    const { window } = launched;
    await expect(window.getByTestId("session-frame")).toBeVisible();
    for (const id of nodeShots) {
      await expect(window.getByTestId(`node-${id}`)).toBeVisible();
    }
    await window.evaluate(() => document.fonts.ready);

    for (const id of nodeShots) {
      await expect
        .soft(window.getByTestId(`node-${id}`))
        .toHaveScreenshot(`${colorScheme}-${id}.png`, exact);
    }
    await expect
      .soft(window.getByTestId("loop-frame-loop"))
      .toHaveScreenshot(`${colorScheme}-loop.png`, exact);
    await expect
      .soft(window.getByTestId("session-frame"))
      .toHaveScreenshot(`${colorScheme}-session.png`, exact);
  });
}

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Parallel start and end draw as tall bars in the ${colorScheme} theme`, async () => {
    seedFlow(home, parallelShapes());
    launched = await launchApp({ home, logPath: join(logDir, "app.log"), colorScheme });
    const { window } = launched;
    const bars = ["fork", "join"];
    for (const id of bars) {
      await expect(window.getByTestId(`node-${id}`)).toBeVisible();
    }
    await window.evaluate(() => document.fonts.ready);

    for (const id of bars) {
      await expect
        .soft(window.getByTestId(`node-${id}`))
        .toHaveScreenshot(`${colorScheme}-${id}.png`, exact);
    }
    for (const id of bars) {
      const box = await window.getByTestId(`node-${id}`).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(200);
    }
  });
}

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`For each draws as a dashed EACH frame in the ${colorScheme} theme`, async () => {
    seedFlow(home, forEachShapes());
    launched = await launchApp({ home, logPath: join(logDir, "app.log"), colorScheme });
    const { window } = launched;
    await expect(window.getByTestId("foreach-frame-each")).toBeVisible();
    await expect(window.getByText("EACH · each plan unit")).toBeVisible();
    await window.evaluate(() => document.fonts.ready);

    await expect
      .soft(window.getByTestId("foreach-frame-each"))
      .toHaveScreenshot(`${colorScheme}-foreach.png`, exact);
  });
}

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Branch draws as an IF hexagon in the ${colorScheme} theme`, async () => {
    seedFlow(home, branchShapes());
    launched = await launchApp({ home, logPath: join(logDir, "app.log"), colorScheme });
    const { window } = launched;
    const node = window.getByTestId("node-branch");
    await expect(node).toBeVisible();
    for (const id of ["trigger", "yes", "no"]) {
      await expect(window.getByTestId(`node-${id}`)).toBeVisible();
    }
    await window.evaluate(() => document.fonts.ready);

    const box = await node.boundingBox();
    expect(box?.width).toBeCloseTo(116, 0);
    expect(box?.height).toBeCloseTo(48, 0);
    expect(await pointsOf(node.locator("polygon").first())).toEqual([
      12, 0, 104, 0, 116, 24, 104, 48, 12, 48, 0, 24,
    ]);
    await expect(node).toContainText("IF");
    await expect(node).toContainText("E2E?");
    await expect(node).toContainText("--no-e2e");

    const port = (name: string) => window.getByTestId(`port-branch-${name}`);
    for (const name of ["in", "yes", "no"]) await expect(port(name)).toBeAttached();
    const [yes, no] = await Promise.all([port("yes").boundingBox(), port("no").boundingBox()]);
    expect([yes?.x, yes?.y]).not.toEqual([no?.x, no?.y]);

    await expect(node).toHaveScreenshot(`${colorScheme}-branch.png`, exact);
  });
}
