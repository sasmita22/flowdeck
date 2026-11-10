import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { mainFlowOnly } from "../src/core/flow/main-flow.js";
import { order } from "../src/core/flow/order.js";
import { parseFlow, type Flow } from "../src/core/flow/schema.js";
import { flow, output, trigger } from "../test/fixtures/flow-builders.js";
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
  turnEnded,
} from "./blueprint-pane.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/copy-flow/${name}`, import.meta.url));
const expectedCopy = parseFlow(
  JSON.parse(readFileSync(fixture("expected-blueprint.json"), "utf8")),
);
const copyAsk = `Copy the flow in ${fixture("source-flow.md")} into this blueprint.`;
const todoAsk =
  "Make a blueprint: an Agent node that lists the TODOs in README.md, then an Agent node that fixes them.";
const agentDeadlineMs = 240_000;
const perAskMs = 360_000;

let home: string;
let flowIds: string[];
let launched: LaunchedApp | undefined;

type Node = Flow["nodes"][number];

const mainSteps = (current: Flow) => {
  const main = mainFlowOnly(current);
  const byId = new Map(main.nodes.map((node) => [node.id, node]));
  return { main, nodes: order(main).flatMap((id) => byId.get(id) ?? []) };
};

const structure = (current: Flow) => {
  const { main, nodes } = mainSteps(current);
  const at = new Map(nodes.map((node, index) => [node.id, index]));
  return {
    types: nodes.map((node) => node.type),
    wires: main.wires
      .map((wire) => `${at.get(wire.from.node)}->${at.get(wire.to.node)} ${wire.kind}`)
      .sort(),
  };
};

const isStep = (node: Node) => node.type !== "trigger" && node.type !== "output";

const standardProblems = (current: Flow) => {
  const steps = mainSteps(current).nodes.filter(isStep);
  return steps.flatMap((node) => {
    const problems: string[] = [];
    if (node.type === "agent") {
      const { role, instructions } = node.settings as { role: string; instructions: string };
      if (role.trim() === "") problems.push(`${node.id}: no role`);
      if (instructions.trim() === "") problems.push(`${node.id}: no instructions`);
      if (!/^Expected output:[ \t]*\S/m.test(instructions)) {
        problems.push(`${node.id}: no "Expected output:" line`);
      }
    }
    return problems;
  });
};

const squeezed = (text: string) => text.replace(/\s+/g, "");

const askOnFreshBlueprint = async (ask: string, tag: string): Promise<Flow> => {
  const id = seedBlueprint(home, tag, flow([trigger("start"), output("stop")], [])).flowId;
  flowIds.push(id);
  launched = await launchOnCanvas({
    home,
    logPath: test.info().outputPath(`${tag}-app.log`),
    env: { FLOWDECK_CLAUDE_CONFIG: join(home, "claude.json"), ANTHROPIC_MODEL: "haiku" },
  });
  const window = launched.window;
  const back = window.getByTestId(controlTestIds.back).or(window.getByTestId(pageTestIds.runBack));
  if (await back.isVisible()) await back.click();
  await window.getByTestId("menu-blueprints").click();
  await window.getByTestId(pageTestIds.blueprintOpen(id)).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();

  await window.getByTestId(toggleId).click();
  await expect
    .poll(() => capture(bpName(id)).then(readyForInput, () => false), { timeout: 60_000 })
    .toBe(true);
  await window.getByTestId(paneId).locator("textarea.xterm-helper-textarea").focus();
  await window.keyboard.type(ask);
  await expect.poll(async () => squeezed(await capture(bpName(id)))).toContain(squeezed(ask));
  await window.keyboard.press("Enter");

  await expect
    .poll(() => turnEnded(home, id), { timeout: agentDeadlineMs, intervals: [2000] })
    .toBe(true);

  const answer = await readBlueprintOverSocket(home, bpName(id));
  expect(answer.ok).toBe(true);
  const result = parseFlow(answer.flow);
  await writeFile(test.info().outputPath(`${tag}-blueprint.json`), JSON.stringify(result, null, 2));
  await keepEvidence(home, id, window, `${tag}-`);
  expect(structure(await readout(window))).toEqual(structure(result));

  const { models, usage } = await modelsAndUsage(home, id);
  console.log(`${tag}: models ${JSON.stringify(models)} usage ${JSON.stringify(usage)}`);
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model).toMatch(/haiku/);

  const current = launched;
  launched = undefined;
  await current.close();
  return result;
};

test.beforeEach(async () => {
  launched = undefined;
  flowIds = [];
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-mt-authoring-live-")));
  await writeFile(join(home, "claude.json"), JSON.stringify({ mcpServers: {} }));
});

test.afterEach(async () => {
  try {
    const failed = test.info().status !== test.info().expectedStatus;
    const last = flowIds.at(-1);
    if (failed && last !== undefined) await keepEvidence(home, last, launched?.window, "failed-");
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    for (const id of flowIds) {
      await killTmux(bpName(id));
      await removeTranscripts(home, id);
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("copies a flow from a local file with the same structure", async () => {
  test.setTimeout(perAskMs);
  const copied = await askOnFreshBlueprint(copyAsk, "copy");
  expect(structure(copied)).toEqual(structure(expectedCopy));
  expect(standardProblems(copied)).toEqual([]);
});

test("the same ask gives the same structure three times", async () => {
  test.setTimeout(3 * perAskMs);
  const structures = [];
  for (const attempt of [1, 2, 3]) {
    structures.push(structure(await askOnFreshBlueprint(todoAsk, `same-${attempt}`)));
  }
  expect(structures[1]).toEqual(structures[0]);
  expect(structures[2]).toEqual(structures[0]);
});

test("writes nodes to the standard", async () => {
  test.setTimeout(perAskMs);
  const written = await askOnFreshBlueprint(todoAsk, "standard");
  expect(mainSteps(written).nodes.filter((node) => node.type === "agent")).not.toHaveLength(0);
  expect(standardProblems(written)).toEqual([]);
});
