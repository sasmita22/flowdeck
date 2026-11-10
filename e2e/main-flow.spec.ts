import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDialogTestIds, controlTestIds } from "../src/app/renderer/test-ids.js";
import { agent, flow, output, thenWire, trigger } from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";
import { waitForBuilt } from "./build-run.js";
import { launchWithFakeClaude } from "./fake-claude.js";

let home: string;
let launched: LaunchedApp | undefined;
let repo: TmpRepo | undefined;

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

test.beforeEach(async () => {
  launched = undefined;
  repo = undefined;
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-mf-")));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await repo?.cleanup();
  }
});

const ticketFlow = () =>
  flow(
    [
      at(trigger("start"), 10, 10),
      at(agent("a"), 120, 10),
      at(output("stop"), 360, 10),
      at(agent("b"), 10, 140),
      at(agent("c"), 10, 260),
      at(agent("d"), 240, 260),
    ],
    [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
  );

const rowsNamed = (table: "builds" | "pending_builds", name: string) => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).all(name);
  } finally {
    db.close();
  }
};

const launchBuilder = async (blueprint: unknown) => {
  repo = await createTmpRepo({ commit: true });
  seedBlueprint(home, "Main flow", blueprint, repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
  return window;
};

const startBuild = async (window: LaunchedApp["window"], name: string) => {
  await window.getByTestId(controlTestIds.build).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
  await window.getByTestId(buildDialogTestIds.name).fill(name);
  await window.getByTestId(buildDialogTestIds.confirm).click();
};

test("Nodes off the main flow are drawn faded", async () => {
  seedFlow(home, ticketFlow());
  launched = await launchOnCanvas({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;

  for (const id of ["b", "c", "d"]) {
    const node = window.getByTestId(`node-${id}`);
    await expect(node).toHaveAttribute("data-ignored", "true");
    await expect(node).toHaveCSS("opacity", "0.4");
  }
  for (const id of ["start", "a", "stop"]) {
    const node = window.getByTestId(`node-${id}`);
    await expect(node).toBeVisible();
    await expect(node).not.toHaveAttribute("data-ignored");
    await expect(node).toHaveCSS("opacity", "1");
  }
});

test("Confirm before ignoring: Cancel builds nothing, Build anyway leaves the loose nodes out", async () => {
  const window = await launchBuilder(ticketFlow());

  await startBuild(window, "loose-cancel");
  const list = window.getByTestId(buildDialogTestIds.ignored);
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toContainText(
    "These nodes aren't connected to the main flow and will be left out",
  );
  for (const id of ["b", "c", "d"]) {
    await expect(list.getByTestId(buildDialogTestIds.ignoredNode(id))).toBeVisible();
  }
  await expect(list.locator("li")).toHaveCount(3);
  await expect(list.getByTestId(buildDialogTestIds.ignoredNode("a"))).toHaveCount(0);
  await window.getByTestId(buildDialogTestIds.ignoredCancel).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  await window.waitForTimeout(1000);
  expect(rowsNamed("pending_builds", "loose-cancel")).toEqual([]);
  expect(rowsNamed("builds", "loose-cancel")).toEqual([]);

  await startBuild(window, "loose-anyway");
  await window.getByTestId(buildDialogTestIds.buildAnyway).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  const buildId = await waitForBuilt(window, home, "loose-anyway");

  const manifest = JSON.parse(
    await readFile(join(home, "workspaces", buildId, "manifest.json"), "utf8"),
  ) as { nodes: { id: string }[]; wires: { from: { node: string }; to: { node: string } }[] };
  expect(manifest.nodes.map(({ id }) => id).sort()).toEqual(["a", "start", "stop"]);
  const wired = manifest.wires.flatMap(({ from, to }) => [from.node, to.node]);
  expect(wired.filter((id) => ["b", "c", "d"].includes(id))).toEqual([]);
});

test("Nothing to confirm: a fully wired blueprint builds without the confirm step", async () => {
  const window = await launchBuilder(
    flow(
      [at(trigger("start"), 10, 10), at(agent("a"), 120, 10), at(output("stop"), 360, 10)],
      [thenWire("start", "a"), thenWire("a", "stop")],
    ),
  );

  await startBuild(window, "wired");
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  await expect(window.getByTestId(buildDialogTestIds.ignored)).toHaveCount(0);
  await waitForBuilt(window, home, "wired");
  expect(rowsNamed("builds", "wired")).toHaveLength(1);
});
