import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  containerTestIds,
  controlTestIds,
  libraryTestIds,
  pageTestIds,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import { labelPrefix } from "../src/core/flow/libraries.js";
import { parseFlow, type Flow } from "../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  output,
  sessionsWorkflow,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { buildOnCanvas } from "./build-run.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { killRunSessions } from "./run-sessions.js";

let home: string;
let launched: LaunchedApp | undefined;
let repo: TmpRepo | undefined;

const run = promisify(execFile);
const tmuxSockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);

const rows = <T>(sql: string, ...params: string[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const killBuildSessions = async () => {
  if (!existsSync(join(home, "flowdeck.db"))) return;
  const names = rows<{ body_json: string }>("SELECT body_json FROM build_events")
    .map((row) => JSON.parse(row.body_json) as { type: string; name?: string })
    .flatMap((event) =>
      event.type === "session" && /^fd-build-/.test(event.name ?? "") ? [event.name ?? ""] : [],
    );
  for (const name of names) {
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
    await rm(join(tmuxSockets, name), { force: true });
  }
};

test.beforeEach(async () => {
  launched = undefined;
  repo = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-lb-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await killBuildSessions();
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
    await repo?.cleanup();
  }
});

const reviewLibrary = (): Flow =>
  flow(
    [trigger("start"), { ...agent("review"), label: "Review" }, output("stop")],
    [thenWire("start", "review"), thenWire("review", "stop")],
    flowSettings,
    { containers: [] },
  );

const placed: Record<string, { x: number; y: number }> = {
  "canvas-start": { x: -300, y: 20 },
  "workspace-1-start": { x: 0, y: 0 },
  "workspace-1-stop": { x: 600, y: 0 },
  "canvas-stop": { x: 900, y: 20 },
  "session-1-start": { x: 0, y: 300 },
  "session-1-stop": { x: 600, y: 300 },
  "session-2-start": { x: 0, y: 600 },
  "session-2-stop": { x: 600, y: 600 },
};

const twoSessionsUnwired = (repoPath: string): Flow => {
  const wired = sessionsWorkflow([
    { name: "android", repo: repoPath, branch: "main", model: "haiku", members: [] },
    { name: "ios", repo: repoPath, branch: "main", model: "haiku", members: [] },
  ]);
  return parseFlow({
    ...wired,
    nodes: wired.nodes.map((node) => ({ ...node, position: placed[node.id] ?? node.position })),
    wires: wired.wires.filter((wire) => !/^session-\d-start$/.test(wire.from.node)),
  });
};

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const dropInto = async (window: Page, item: Locator, frame: Locator) => {
  const canvas = await boxOf(window.getByTestId("canvas"));
  const box = await boxOf(frame);
  await item.dragTo(window.getByTestId("canvas"), {
    targetPosition: {
      x: box.x + box.width / 2 - canvas.x,
      y: box.y + box.height - 20 - canvas.y,
    },
  });
};

const connectPorts = async (window: Page, from: string, to: string) => {
  const source = await boxOf(window.getByTestId(from));
  const target = await boxOf(window.getByTestId(to));
  await window.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await window.mouse.down();
  await window.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
    steps: 12,
  });
  await window.mouse.up();
};

type ManifestNode = { id: string; type: string; piece?: string; file?: string };

const builtAgents = (buildId: string): ManifestNode[] =>
  rows<{ manifest_json: string }>(
    "SELECT manifest_json FROM build_manifests WHERE build_id = ?",
    buildId,
  )
    .flatMap(
      (row) =>
        (JSON.parse(row.manifest_json) as { containers: { nodes: ManifestNode[] }[] }).containers,
    )
    .flatMap(({ nodes }) => nodes)
    .filter((node) => node.type === "agent");

test("One node library used in two sessions builds one piece per use, each with its own agent id and piece file", async () => {
  test.setTimeout(120_000);
  repo = await createTmpRepo({ commit: true });
  const library = seedBlueprint(home, "Review", reviewLibrary());
  const host = seedBlueprint(home, "Two apps", twoSessionsUnwired(repo.path));
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(host.flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();

  const item = window.getByTestId(libraryTestIds.paletteItem(library.flowId));
  await expect(item).toBeVisible();
  for (const [index, session] of ["session-1", "session-2"].entries()) {
    await dropInto(window, item, window.getByTestId(containerTestIds.frame(session)));
    const use = `library-${index + 1}`;
    await expect(window.getByTestId(`node-${use}`)).toBeVisible();
    await connectPorts(window, `port-${session}-start-out`, `port-${use}-in`);
    await connectPorts(window, `port-${use}-out`, `port-${session}-stop-in`);
  }
  const drawn = JSON.parse(
    (await window.getByTestId(readoutTestIds.flow).textContent()) ?? "",
  ) as Flow;
  expect(
    drawn.containers
      .filter(({ kind }) => kind === "session")
      .map(({ id, nodes }) => [id, nodes.filter((node) => node.startsWith("library-"))]),
  ).toEqual([
    ["session-1", ["library-1"]],
    ["session-2", ["library-2"]],
  ]);
  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);

  const buildId = await buildOnCanvas(window, home, "two-reviews");

  const prefixes = drawn.nodes.flatMap((node) =>
    node.type === "library" ? [labelPrefix(node.settings.label)] : [],
  );
  expect(new Set(prefixes).size).toBe(2);
  const agents = builtAgents(buildId);
  expect(agents).toHaveLength(2);
  expect(agents.map(({ id }) => id).sort()).toEqual(
    prefixes.map((prefix) => `${prefix}-review`).sort(),
  );
  const files = agents.map(({ file }) => file);
  expect(files.every((file) => file !== undefined)).toBe(true);
  expect(new Set(files).size).toBe(2);
});
