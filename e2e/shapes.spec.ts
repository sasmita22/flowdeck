import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agent,
  ask,
  flow,
  gate,
  hardstop,
  loop,
  output,
  prompt,
  script,
  trigger,
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
