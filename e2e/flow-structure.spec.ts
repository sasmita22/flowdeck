import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containerTestIds,
  controlTestIds,
  pageTestIds,
  paletteTestId,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import {
  agent,
  bareFlow,
  flow,
  inOneSession,
  loop,
  onWorkspaceMainFlow,
  workspaceFlow,
  output,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildAndRun, buildOnCanvas, runFromDetail, startInRunDialog } from "./build-run.js";
import { endSessionsOfHome } from "./own-sessions.js";
import { workspaceFolder } from "../src/core/run/workspace.js";

let home: string;
let repo: TmpRepo;
let bin: string;
let launched: LaunchedApp | undefined;

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const named = (id: string, label: string, settings: Record<string, unknown> = {}) => ({
  ...agent(id, { settings }),
  label,
});

const verdictDone = ["```json", '{"done": true}', "```"].join("\n");

const fakeClaude = `
const { connect } = require("node:net");
const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? "";
const sock = process.env.FLOWDECK_SOCK ?? "";
let typed = "";
const draw = () =>
  process.stdout.write("\\x1b[2J\\x1b[HFake Claude\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n");
const send = (event) => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ session_id: sessionId, ...event }) + "\\n");
  });
  socket.on("error", () => undefined);
};
const stop = () => send({ hook_event_name: "Stop", last_assistant_message: ${JSON.stringify(verdictDone)} });
const dispatched = /subagent_type "([^"]+)" and the prompt "NODE ([^\\\\"]+)/;
const turn = (text) => {
  const match = dispatched.exec(text);
  if (match === null) return setTimeout(stop, 50);
  const [, agentType, nodeId] = match;
  setTimeout(() => {
    send({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "fake-" + nodeId + "-" + Date.now(),
      tool_input: { subagent_type: agentType, prompt: "NODE " + nodeId + "\\nGo" },
      tool_response: { agentType, status: "completed" },
    });
    setTimeout(stop, 100);
  }, 50);
};
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") {
      if (typed !== "") turn(typed);
      typed = "";
    } else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const launch = async () => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    ownBin: bin,
  });
  await expect(launched.window.getByTestId(controlTestIds.save)).toBeVisible();
  return launched.window;
};

const relaunch = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
  return launch();
};

type Readout = {
  nodes: { id: string; parent?: string; settings: object }[];
  wires: { kind: string; from: { node: string }; to: { node: string } }[];
  containers: { id: string; nodes: string[] }[];
};

const readout = async (window: Page): Promise<Readout> =>
  JSON.parse((await window.getByTestId(readoutTestIds.flow).textContent()) ?? "") as Readout;

const parentIn = async (window: Page, id: string) =>
  (await readout(window)).nodes.find((node) => node.id === id)?.parent;

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};

const dropOn = async (
  window: Page,
  type: "agent" | "loop" | "trigger" | "output",
  x: number,
  y: number,
) => {
  const canvas = await boxOf(window.getByTestId("canvas"));
  await window.getByTestId(paletteTestId(type)).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: x - canvas.x, y: y - canvas.y },
  });
};

const dropInFrame = async (window: Page, type: "agent", frame: Locator) => {
  const box = await boxOf(frame);
  await dropOn(window, type, box.x + 30, box.y + box.height - 14);
};

const dragBy = async (window: Page, target: Locator, dx: number, dy: number) => {
  const box = await boxOf(target);
  const x = box.x + box.width / 2;
  const y = box.y + 12;
  await window.mouse.move(x, y);
  await window.mouse.down();
  await window.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await window.mouse.move(x + dx, y + dy, { steps: 6 });
  await window.mouse.up();
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

const darkShot = async (window: Page, name: string) => {
  await window.emulateMedia({ colorScheme: "dark" });
  await window.mouse.move(1, 1);
  const path = test.info().outputPath(name);
  await window.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
  await window.emulateMedia({ colorScheme: null });
};

const rows = <T>(sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const latestRunId = () =>
  rows<{ id: string }>("SELECT id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1")[0]?.id;

const kindsOf = (runId: string | undefined, nodeId: string) =>
  rows<{ kind: string }>(
    "SELECT kind FROM events WHERE run_id = ? AND node_id = ? ORDER BY seq",
    runId,
    nodeId,
  ).map((row) => row.kind);

const status = (window: Page, nodeId: string, round?: number) =>
  window.getByTestId(pageTestIds.runStageStatus(latestRunId() ?? "no-run", nodeId, round));

const seed = (input: Flow) => seedFlow(home, input, repo.path);

const workFolder = (buildId: string) => workspaceFolder(join(home, "workspaces", buildId));

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-fs-"));
  repo = await createTmpRepo({ commit: true });
  bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
});

test.afterEach(async () => {
  try {
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    try {
      await endSessionsOfHome(home);
      await rm(home, { recursive: true, force: true });
    } finally {
      await repo.cleanup();
    }
  }
});

test("An Agent dropped onto a Loop frame is in its body after save and reload, and dragging it out takes it out", async () => {
  seed(flow([at(loop("loop-1"), 120, 120)], []));
  let window = await launch();

  await dropInFrame(window, "agent", window.getByTestId("loop-frame-loop-1"));

  await expect(window.getByTestId("node-agent-1")).toBeVisible();
  expect(await parentIn(window, "agent-1")).toBe("loop-1");
  const frame = await boxOf(window.getByTestId("loop-frame-loop-1"));
  const body = await boxOf(window.getByTestId("node-agent-1"));
  expect(body.y + body.height).toBeLessThanOrEqual(frame.y + frame.height);

  await window.getByTestId(controlTestIds.save).click();
  window = await relaunch();

  await expect(window.getByTestId("node-agent-1")).toBeVisible();
  expect(await parentIn(window, "agent-1")).toBe("loop-1");
  await expect(window.getByTestId("node-issue-loop-1")).toHaveCount(0);
  await darkShot(window, "nested.png");

  await dragBy(window, window.getByTestId("node-agent-1"), 420, 160);

  await expect.poll(() => parentIn(window, "agent-1")).toBeUndefined();
  await expect(window.getByTestId("node-issue-loop-1")).toHaveText("Has no agent in its body.");

  await window.getByTestId(controlTestIds.undo).click();
  await expect.poll(() => parentIn(window, "agent-1")).toBe("loop-1");
});

test("Dragging a Loop moves its body with it", async () => {
  seed(flow([at(loop("L"), 120, 120), at(agent("P", { parent: "L" }), 140, 200)], []));
  const window = await launch();
  const loopBefore = await boxOf(window.getByTestId("node-L"));
  const bodyBefore = await boxOf(window.getByTestId("node-P"));

  await dragBy(window, window.getByTestId("node-L"), 200, 60);

  await expect
    .poll(async () => (await boxOf(window.getByTestId("node-L"))).x)
    .toBeGreaterThan(loopBefore.x + 100);
  const loopAfter = await boxOf(window.getByTestId("node-L"));
  const bodyAfter = await boxOf(window.getByTestId("node-P"));
  expect(bodyAfter.x - bodyBefore.x).toBeCloseTo(loopAfter.x - loopBefore.x, 0);
  expect(bodyAfter.y - bodyBefore.y).toBeCloseTo(loopAfter.y - loopBefore.y, 0);
  expect(await parentIn(window, "P")).toBe("L");
  await expect(window.getByTestId(controlTestIds.undo)).toBeEnabled();
});

test("Clicking inside a Loop frame selects the Loop and opens its settings", async () => {
  seed(flow([at(loop("L"), 120, 120), at(agent("P", { parent: "L" }), 340, 200)], []));
  const window = await launch();
  const frame = await boxOf(window.getByTestId("loop-frame-L"));

  await window.mouse.click(frame.x + 40, frame.y + frame.height - 16);

  await expect(window.getByTestId(readoutTestIds.selection)).toHaveText('["L"]');
  await expect(window.getByTestId("node-type-tag")).toHaveText("LOOP");

  await window.getByTestId("node-P").click();
  await expect(window.getByTestId(readoutTestIds.selection)).toHaveText('["P"]');
});

test("Deleting a Loop deletes its body with it, orphaning nothing, and undo brings both back", async () => {
  seed(
    inOneSession(
      [
        at(agent("A"), 0, 120),
        at(loop("L"), 260, 120),
        at(agent("P", { parent: "L" }), 260, 200),
        at(agent("B"), 560, 120),
      ],
      [thenWire("A", "P"), thenWire("L", "B")],
    ),
  );
  const window = await launch();

  await window.getByTestId("node-L").click();
  await window.getByTestId(controlTestIds.delete).click();

  await expect(window.getByTestId("node-P")).toHaveCount(0);
  const after = await readout(window);
  expect(after.nodes.map((node) => node.id)).toEqual(["A", "B"]);
  expect(after.wires).toEqual([]);
  await expect(window.locator('[data-testid^="node-issue-"]')).toHaveCount(0);

  await window.getByTestId(controlTestIds.undo).click();

  await expect(window.getByTestId("node-P")).toBeVisible();
  expect(await parentIn(window, "P")).toBe("L");
  expect((await readout(window)).wires).toHaveLength(2);
});

test("A fresh Loop says on the canvas that its body needs an Agent", async () => {
  seed(bareFlow());
  const window = await launch();

  await dropOn(window, "loop", 500, 300);

  const issue = window.getByTestId("node-issue-loop-1");
  await expect(issue).toHaveText("2 problems");
  await expect(issue).toHaveAttribute(
    "title",
    "Write when the loop is done.\nHas no agent in its body.",
  );
  await expect(window.getByText("LOOP · max 3")).toBeVisible();
});

test("Planner writes plan.md and Builder is given it, set in the inspector, and it survives a reload", async () => {
  seed(
    inOneSession(
      [at(named("plan", "Planner"), 80, 160), at(named("build", "Builder"), 420, 160)],
      [thenWire("plan", "build")],
    ),
  );
  let window = await launch();
  await expect(window.getByTestId("port-plan-file-out")).toHaveCount(0);
  await expect(window.getByTestId("port-build-file-in")).toHaveCount(0);

  await window.getByTestId("node-plan").click();
  await window.getByTestId("node-setting-writes").fill("plan.md");
  await window.getByTestId("node-setting-writes").blur();
  await window.getByTestId("node-build").click();
  await window.getByTestId("node-setting-given").fill("plan.md");
  await window.getByTestId("node-setting-given").blur();

  const settingsOf = async (id: string) =>
    (await readout(window)).nodes.find((node) => node.id === id)?.settings;
  await expect.poll(() => settingsOf("build")).toMatchObject({ given: ["plan.md"] });
  await window.getByTestId(controlTestIds.save).click();
  window = await relaunch();

  expect(await settingsOf("plan")).toMatchObject({ writes: ["plan.md"] });
  expect(await settingsOf("build")).toMatchObject({ given: ["plan.md"] });
  expect((await readout(window)).wires).toEqual([thenWire("plan", "build")]);
  await window.getByTestId("node-build").click();
  await expect(window.getByTestId("node-setting-given")).toHaveValue("plan.md");
  await darkShot(window, "handoff.png");
});

test("A run holds the reader until the file it is given is written", async () => {
  seed(
    onWorkspaceMainFlow(
      [
        at(named("plan", "Planner", { writes: ["plan.md"] }), 80, 160),
        at(named("build", "Builder", { given: ["plan.md"] }), 420, 160),
      ],
      [thenWire("plan", "build")],
    ),
  );
  const window = await launch();

  const folder = workFolder(await buildAndRun(window, home, "handoff"));

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("failed", {
    timeout: 20_000,
  });
  const failedRun = latestRunId();
  await window.getByTestId(pageTestIds.runStage(failedRun ?? "no-run", "build")).click();
  await expect(
    window.getByTestId(pageTestIds.runStageReason(failedRun ?? "no-run", "build")),
  ).toHaveText("plan.md wasn't written by Planner");
  expect(kindsOf(failedRun, "plan")).toEqual(["sent", "done"]);
  expect(kindsOf(failedRun, "build")).toEqual(["running", "failed"]);

  await writeFile(join(folder, "plan.md"), "- one\n");
  await window.getByTestId(pageTestIds.runAgain).click();
  await startInRunDialog(window);

  await expect.poll(() => latestRunId(), { timeout: 20_000 }).not.toBe(failedRun);
  await expect(status(window, "build")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  expect(kindsOf(latestRunId(), "build")).toEqual(["sent", "done"]);
});

for (const container of ["loop"] as const) {
  test("A Loop drawn in the app runs to done from its build", async () => {
    const drawn = workspaceFlow([at(trigger("start"), 0, 120), at(output("stop"), 700, 120)], []);
    seed({
      ...drawn,
      nodes: drawn.nodes.map((node) =>
        node.id === "session-1-start"
          ? at(node, 0, 480)
          : node.id === "session-1-stop"
            ? at(node, 700, 480)
            : node,
      ),
    });
    const window = await launch();
    const workspace = await boxOf(window.getByTestId(containerTestIds.frame("workspace-1")));
    await dropOn(
      window,
      container,
      workspace.x + workspace.width / 2,
      workspace.y + workspace.height / 2,
    );
    const id = `${container}-1`;
    await expect
      .poll(
        async () =>
          (await readout(window)).containers.find((found) => found.id === "workspace-1")?.nodes,
      )
      .toEqual(["start", "stop", id]);
    await dropInFrame(window, "agent", window.getByTestId(`${container}-frame-${id}`));
    await expect.poll(() => parentIn(window, "agent-1")).toBe(id);
    await window.getByTestId(`node-${id}`).click();
    await window.getByTestId("node-setting-condition").fill("The work is done.");
    await window.getByTestId("node-setting-condition").blur();
    await window.getByTestId("node-agent-1").click();
    await window.getByTestId("node-setting-instructions").fill("Say done.");
    await window.getByTestId("node-setting-instructions").blur();
    await window.getByTestId(controlTestIds.zoomOut).click();
    await connectPorts(
      window,
      window.getByTestId("port-start-out"),
      window.getByTestId(`port-${id}-in`),
    );
    await connectPorts(
      window,
      window.getByTestId(`port-${id}-out`),
      window.getByTestId("port-stop-in"),
    );
    await expect(window.getByTestId(`node-issue-${id}`)).toHaveCount(0);
    await expect(window.getByTestId("node-issue-agent-1")).toHaveCount(0);

    await buildOnCanvas(window, home, container);
    await runFromDetail(window);

    await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(status(window, id)).toHaveAttribute("data-status", "done");
    const rounds = kindsOf(latestRunId(), id).filter((kind) => kind === "round");
    expect(rounds).toHaveLength(1);
    const runId = latestRunId() ?? "no-run";
    const shownPerRound: string[][] = [];
    for (const round of rounds.keys()) {
      await expect(status(window, "agent-1", round + 1)).toHaveAttribute("data-status", "done");
      await window.getByTestId(pageTestIds.runStage(runId, "agent-1", round + 1)).click();
      const entries = window
        .getByTestId(pageTestIds.runStageDetail(runId, "agent-1", round + 1))
        .locator('[data-testid^="activity-entry-"]');
      await expect(entries.first()).toBeVisible();
      shownPerRound.push(
        await entries.evaluateAll((found) => found.map((entry) => entry.dataset.testid ?? "")),
      );
    }
    const shown = shownPerRound.flat();
    expect(new Set(shown).size).toBe(shown.length);
  });
}
