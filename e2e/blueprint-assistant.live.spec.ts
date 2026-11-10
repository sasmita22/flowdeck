import { expect, test } from "@playwright/test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { flow, prompt } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";
import {
  bpName,
  capture,
  keepEvidence,
  killTmux,
  modelsAndUsage,
  paneId,
  readBlueprintOverSocket,
  readout,
  readyForInput,
  removeTranscripts,
  toggleId,
} from "./blueprint-pane.js";

const ask = "add a Script node that runs npm test after the planner";
const agentDeadlineMs = 240_000;

let home: string;
let flowId: string | undefined;
let launched: LaunchedApp | undefined;

test.setTimeout(360_000);

type Node = Flow["nodes"][number];

const runsNpmTest = (node: Node) => {
  if (node.type !== "script") return false;
  const { command, args = [] } = node.settings as { command: string; args?: string[] };
  return [command, ...args].join(" ").trim().replace(/\s+/g, " ") === "npm test";
};

const scriptAfterPlanner = (current: Flow) =>
  current.nodes.find(
    (node) =>
      runsNpmTest(node) &&
      current.wires.some(
        (wire) => wire.kind === "then" && wire.from.node === "planner" && wire.to.node === node.id,
      ),
  );

test.beforeEach(async () => {
  launched = undefined;
  flowId = undefined;
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-mt-ba-live-")));
  await writeFile(join(home, "claude.json"), JSON.stringify({ mcpServers: {} }));
});

test.afterEach(async () => {
  try {
    const failed = test.info().status !== test.info().expectedStatus;
    if (failed && flowId !== undefined) await keepEvidence(home, flowId, launched?.window);
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    if (flowId !== undefined) {
      await killTmux(bpName(flowId));
      await removeTranscripts(home, flowId);
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("a real agent adds a Script node running npm test, wired after the planner", async () => {
  const id = seedBlueprint(home, "live", flow([prompt("planner")], [])).flowId;
  flowId = id;
  launched = await launchOnCanvas({
    home,
    logPath: test.info().outputPath("app.log"),
    env: { FLOWDECK_CLAUDE_CONFIG: join(home, "claude.json"), ANTHROPIC_MODEL: "haiku" },
  });
  const window = launched.window;
  const back = window.getByTestId(controlTestIds.back).or(window.getByTestId(pageTestIds.runBack));
  if (await back.isVisible()) await back.click();
  await window.getByTestId("menu-blueprints").click();
  await window.getByTestId(pageTestIds.blueprintOpen(id)).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
  expect(scriptAfterPlanner(await readout(window))).toBeUndefined();

  await window.getByTestId(toggleId).click();
  await expect
    .poll(() => capture(bpName(id)).then(readyForInput, () => false), { timeout: 60_000 })
    .toBe(true);
  await window.getByTestId(paneId).locator("textarea.xterm-helper-textarea").focus();
  await window.keyboard.type(ask);
  await expect.poll(() => capture(bpName(id))).toContain("after the planner");
  await window.keyboard.press("Enter");

  await expect
    .poll(async () => scriptAfterPlanner(await readout(window))?.id, {
      timeout: agentDeadlineMs,
      intervals: [2000],
    })
    .toBeDefined();
  const added = scriptAfterPlanner(await readout(window));
  await expect(window.getByTestId(`rf__node-${added?.id}`)).toBeVisible();
  await expect(window.getByTestId(`rf__edge-planner:out->${added?.id}:in`)).toBeAttached();
  const answer = await readBlueprintOverSocket(home, bpName(id));
  expect(answer).toMatchObject({ ok: true, unsaved: true });
  expect(answer.flow && scriptAfterPlanner(answer.flow)?.id).toBe(added?.id);

  const { models, usage } = await modelsAndUsage(home, id);
  console.log(`agent pane:\n${await capture(bpName(id))}`);
  console.log(`models ${JSON.stringify(models)} usage ${JSON.stringify(usage)}`);
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model).toMatch(/haiku/);
});
