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
import { nodeTitle } from "../src/app/renderer/canvas/palette-items.js";

let home: string;
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
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Every node type draws its own shape in the ${colorScheme} theme`, async () => {
    seedFlow(home, everyShape());
    launched = await launchApp({ home, logPath: test.info().outputPath("app.log"), colorScheme });
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
    launched = await launchApp({ home, logPath: test.info().outputPath("app.log"), colorScheme });
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
    launched = await launchApp({ home, logPath: test.info().outputPath("app.log"), colorScheme });
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
    launched = await launchApp({ home, logPath: test.info().outputPath("app.log"), colorScheme });
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

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("A parallel start and end show their full tag inside the bar and their label above it, clear of every node", async () => {
  seedFlow(
    home,
    flow(
      [
        at(trigger("trigger"), 80, 120),
        { ...at(fork("fork"), 298, 40), label: "Split the review" },
        at(prompt("b1"), 374, 40),
        at(prompt("b2"), 374, 120),
        at(prompt("b3"), 374, 200),
        { ...at(joinNode("join"), 592, 120), label: "Wait for all reviewers" },
        at(output("output"), 668, 120),
      ],
      [
        thenWire("trigger", "fork"),
        ...["b1", "b2", "b3"].flatMap((id) => [thenWire("fork", id), thenWire(id, "join")]),
        thenWire("join", "output"),
      ],
    ),
  );
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId("node-output")).toBeVisible();
  const nodes = await Promise.all(
    (await window.locator(".react-flow__node").all()).map((node) => boxOf(node)),
  );
  expect(nodes).toHaveLength(7);

  for (const [id, tag, label] of [
    ["fork", "PARALLEL START", "Split the review"],
    ["join", "PARALLEL END", "Wait for all reviewers"],
  ] as const) {
    const bar = window.getByTestId(`node-${id}`);
    const barBox = await boxOf(bar);
    const tagText = bar.locator("text", { hasText: tag });
    await expect(tagText).toHaveText(tag);
    expect(inside(await boxOf(tagText), barBox)).toBe(true);
    const labelText = bar.getByText(label, { exact: true });
    await expect(labelText).toBeVisible();
    const labelBox = await boxOf(labelText);
    expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(barBox.y);
    expect(intersects(labelBox, barBox)).toBe(false);
    for (const node of nodes) expect(intersects(labelBox, node)).toBe(false);
  }
});

test("Hovering a node says what it is and what it does", async () => {
  seedFlow(home, parallelShapes());
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;

  for (const [id, type] of [
    ["b1", "agent"],
    ["fork", "fork"],
  ] as const) {
    const node = window.getByTestId(`node-${id}`);
    await node.hover();
    await expect(node).toHaveAttribute("title", nodeTitle(type));
  }
});
