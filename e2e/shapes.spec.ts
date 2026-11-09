import { expect, test, type Locator, type Page } from "@playwright/test";
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
import { launchOnCanvas, type ColorScheme, type LaunchedApp } from "../scripts/drive.js";
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
  return seeded;
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

const branchShapes = () => {
  const drawn = flow(
    [
      at(trigger("trigger"), 10, 10),
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
  return {
    ...drawn,
    session: {
      ...drawn.session,
      buildConfig: {
        ...drawn.session.buildConfig,
        variables: [{ name: "e2e", kind: "yesno" as const, default: true }],
      },
    },
  };
};

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
    launched = await launchOnCanvas({
      home,
      logPath: test.info().outputPath("app.log"),
      colorScheme,
    });
    const { window } = launched;
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
  });
}

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Parallel start and end draw as tall bars in the ${colorScheme} theme`, async () => {
    seedFlow(home, parallelShapes());
    launched = await launchOnCanvas({
      home,
      logPath: test.info().outputPath("app.log"),
      colorScheme,
    });
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
    launched = await launchOnCanvas({
      home,
      logPath: test.info().outputPath("app.log"),
      colorScheme,
    });
    const { window } = launched;
    await expect(window.getByTestId("foreach-frame-each")).toBeVisible();
    await expect(window.getByText("EACH · each plan unit")).toBeVisible();
    await window.evaluate(() => document.fonts.ready);

    await expect
      .soft(window.getByTestId("foreach-frame-each"))
      .toHaveScreenshot(`${colorScheme}-foreach.png`, exact);

    await window.getByTestId("node-each").click();
    await expect
      .soft(window.getByTestId("foreach-frame-each"))
      .toHaveScreenshot(`${colorScheme}-foreach-selected.png`, exact);
  });
}

for (const colorScheme of ["light", "dark"] satisfies ColorScheme[]) {
  test(`Branch draws as an IF hexagon in the ${colorScheme} theme`, async () => {
    seedFlow(home, branchShapes());
    launched = await launchOnCanvas({
      home,
      logPath: test.info().outputPath("app.log"),
      colorScheme,
    });
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
    await expect(node).toContainText("e2e");
    await expect(node).not.toContainText("--no-");

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
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
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
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
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

const directParallel = () =>
  flow([at(fork("fork"), 100, 60), at(joinNode("join"), 400, 60)], [thenWire("fork", "join")]);

const storedY = async (window: Page) => {
  const saved = JSON.parse((await window.getByTestId("canvas-flow").textContent()) ?? "") as {
    nodes: { id: string; position: { y: number } }[];
  };
  const y = (id: string) => saved.nodes.find((node) => node.id === id)?.position.y ?? NaN;
  return { fork: y("fork"), join: y("join") };
};

test("A Parallel start wired straight to a Parallel end keeps each bar where it is dragged", async () => {
  seedFlow(home, directParallel());
  launched = await launchOnCanvas({
    home,
    logPath: test.info().outputPath("app.log"),
    colorScheme: "light",
  });
  const { window } = launched;
  const bars = { fork: window.getByTestId("node-fork"), join: window.getByTestId("node-join") };
  await expect(bars.fork).toBeVisible();
  await expect(bars.join).toBeVisible();
  await expect(window.getByTestId("rf__edge-fork:out->join:in")).toBeAttached();
  await window.evaluate(() => document.fonts.ready);
  const start = { fork: await boxOf(bars.fork), join: await boxOf(bars.join) };
  const stored0 = await storedY(window);
  const drawnDy = async () => ({
    fork: Math.round((await boxOf(bars.fork)).y - start.fork.y),
    join: Math.round((await boxOf(bars.join)).y - start.join.y),
    heights: [(await boxOf(bars.fork)).height, (await boxOf(bars.join)).height],
  });
  const heights = [start.fork.height, start.join.height];

  const drag = async (id: "fork" | "join", dy: number) => {
    const other = id === "fork" ? "join" : "fork";
    const before = await drawnDy();
    const box = await boxOf(bars[id]);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await window.mouse.move(x, y);
    await window.mouse.down();
    await window.mouse.move(x, y + Math.sign(dy) * 2);
    await window.mouse.move(x, y + dy / 2, { steps: 6 });
    await window.mouse.move(x, y + dy, { steps: 6 });
    await expect
      .poll(async () => {
        const now = await drawnDy();
        return {
          followsPointer: Math.abs(now[id] - before[id] - dy) <= 4,
          other: now[other],
          heights: now.heights,
        };
      })
      .toEqual({ followsPointer: true, other: before[other], heights });
    await window.mouse.up();

    const stored = await storedY(window);
    expect(stored[other] - stored0[other]).toBe(before[other]);
    await expect.poll(drawnDy).toEqual({
      ...before,
      [id]: Math.round(stored[id] - stored0[id]),
      heights,
    });
  };

  await drag("fork", -40);
  await drag("fork", 160);
  await drag("join", -40);
  await drag("join", 260);

  await window.mouse.move(1, 1);
  const forkBox = await boxOf(bars.fork);
  const joinBox = await boxOf(bars.join);
  const top = Math.min(forkBox.y, joinBox.y) - 32;
  const bottom = Math.max(forkBox.y + forkBox.height, joinBox.y + joinBox.height) + 32;
  await expect(window).toHaveScreenshot("direct-parallel-wire.png", {
    ...exact,
    clip: {
      x: forkBox.x - 24,
      y: top,
      width: joinBox.x + joinBox.width - forkBox.x + 200,
      height: bottom - top,
    },
  });
});
