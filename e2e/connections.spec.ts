import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerTestIds, controlTestIds, readoutTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import {
  flow,
  flowSettings,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";
import { endSessionsOfHome } from "./own-sessions.js";

let home: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-cn-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await endSessionsOfHome(home);
    await rm(home, { recursive: true, force: true });
  }
});

const placedAt = <N extends object>(node: N, x: number, y: number) => ({
  ...node,
  position: { x, y },
});

const twoSessions = (): Flow =>
  flow(
    [
      placedAt(trigger("w-start"), 0, 0),
      placedAt(output("w-stop"), 300, 0),
      placedAt(trigger("a-start"), 0, 250),
      placedAt(output("a-stop"), 300, 250),
      placedAt(trigger("i-start"), 600, 500),
      placedAt(output("i-stop"), 900, 500),
    ],
    [thenWire("w-start", "w-stop"), thenWire("a-start", "a-stop"), thenWire("i-start", "i-stop")],
    flowSettings,
    {
      containers: [
        workspaceContainer(["w-start", "w-stop"]),
        sessionContainer(["a-start", "a-stop"], { id: "android", name: "android" }),
        sessionContainer(["i-start", "i-stop"], { id: "ios", name: "ios" }),
      ],
    },
  );

const launch = async () => {
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched.window;
};

const readout = async (window: Page): Promise<Flow> =>
  JSON.parse((await window.getByTestId(readoutTestIds.flow).textContent()) ?? "") as Flow;

const centerOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const drag = async (window: Page, from: Locator, to: Locator) => {
  const source = await centerOf(from);
  const target = await centerOf(to);
  await window.mouse.move(source.x, source.y);
  await window.mouse.down();
  await window.mouse.move(target.x, target.y, { steps: 12 });
  await window.mouse.up();
};

test("A drawn session connection is dashed with a head at each end, and one undo removes it", async () => {
  seedFlow(home, twoSessions());
  const window = await launch();

  await drag(
    window,
    window.getByTestId(containerTestIds.frameSource("android")),
    window.getByTestId(containerTestIds.frameTarget("ios")),
  );

  await expect
    .poll(async () => (await readout(window)).connections)
    .toEqual([{ id: expect.any(String), between: ["android", "ios"] }]);
  const [connection] = (await readout(window)).connections ?? [];
  const path = window.getByTestId(containerTestIds.connection(connection?.id ?? ""));
  await expect(path).toHaveAttribute("marker-start", /^url\(/);
  await expect(path).toHaveAttribute("marker-end", /^url\(/);
  expect(await path.evaluate((element) => getComputedStyle(element).strokeDasharray)).not.toBe(
    "none",
  );
  await window.screenshot({ path: test.info().outputPath("connected.png") });

  await window.getByTestId(controlTestIds.undo).click();

  await expect(path).toHaveCount(0);
  expect(await readout(window)).not.toHaveProperty("connections");
});

test("A drag from a frame's flow-out to another frame's flow-in draws a solid wire, not a connection", async () => {
  seedFlow(home, twoSessions());
  const window = await launch();

  await drag(
    window,
    window.getByTestId(containerTestIds.frameFlowOut("android")),
    window.getByTestId(containerTestIds.frameFlowIn("ios")),
  );

  const wire = {
    kind: "then",
    from: { node: "android", port: "flow-out" },
    to: { node: "ios", port: "flow-in" },
  };
  await expect.poll(async () => (await readout(window)).wires).toContainEqual(wire);
  expect(await readout(window)).not.toHaveProperty("connections");
  const edge = window.locator(
    `[data-id="android:flow-out->ios:flow-in"] path.react-flow__edge-path`,
  );
  await expect(edge).toHaveCount(1);
  expect(await edge.evaluate((element) => getComputedStyle(element).strokeDasharray)).toBe("none");
  await window.screenshot({ path: test.info().outputPath("wired.png") });
});
