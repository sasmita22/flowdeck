import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  controlTestIds,
  pageTestIds,
  paletteTestId,
  readoutTestIds,
} from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { fileWire, flow, loop, prompt, script, thenWire } from "../test/fixtures/flow-builders.js";
import { seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const exec = promisify(execFile);

let home: string;
let folder: string;
let bin: string;
let launched: LaunchedApp | undefined;

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const sh = (id: string, label: string, command: string) => ({
  ...script(id, { settings: { command: "sh", args: ["-c", command] } }),
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
const stop = () => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ hook_event_name: "Stop", session_id: sessionId, last_assistant_message: ${JSON.stringify(verdictDone)} }) + "\\n");
  });
  socket.on("error", () => undefined);
};
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") {
      if (typed !== "") setTimeout(stop, 50);
      typed = "";
    } else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const launch = async () => {
  launched = await launchApp({
    home,
    logPath: test.info().outputPath("app.log"),
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
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
  nodes: { id: string; parent?: string }[];
  wires: { kind: string; file?: string; from: { node: string }; to: { node: string } }[];
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

const dropOn = async (window: Page, type: "prompt" | "loop" | "foreach", x: number, y: number) => {
  const canvas = await boxOf(window.getByTestId("canvas"));
  await window.getByTestId(paletteTestId(type)).dragTo(window.getByTestId("canvas"), {
    targetPosition: { x: x - canvas.x, y: y - canvas.y },
  });
};

const dropInFrame = async (window: Page, type: "prompt", frame: Locator) => {
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

const sessionNames = (): { tmux_name: string }[] => {
  try {
    return rows("SELECT tmux_name FROM run_sessions");
  } catch {
    return [];
  }
};

const killTmux = async () => {
  const names = sessionNames();
  for (const { tmux_name: name } of names) {
    await exec("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
  }
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const status = (window: Page, nodeId: string) => window.getByTestId(`node-status-${nodeId}`);

const seed = (input: Flow) => seedFlow(home, input, folder);

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-fs-"));
  folder = await realpath(await mkdtemp(join(tmpdir(), "fd-fs-wf-")));
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
    await killTmux();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test("A Prompt dropped onto a Loop frame is in its body after save and reload, and dragging it out takes it out", async () => {
  seed(flow([at(loop("loop-1"), 120, 120)], []));
  let window = await launch();

  await dropInFrame(window, "prompt", window.getByTestId("loop-frame-loop-1"));

  await expect(window.getByTestId("node-prompt-1")).toBeVisible();
  expect(await parentIn(window, "prompt-1")).toBe("loop-1");
  const frame = await boxOf(window.getByTestId("loop-frame-loop-1"));
  const body = await boxOf(window.getByTestId("node-prompt-1"));
  expect(body.y + body.height).toBeLessThanOrEqual(frame.y + frame.height);

  await window.getByTestId(controlTestIds.save).click();
  window = await relaunch();

  await expect(window.getByTestId("node-prompt-1")).toBeVisible();
  expect(await parentIn(window, "prompt-1")).toBe("loop-1");
  await expect(window.getByTestId("node-issue-loop-1")).toHaveCount(0);
  await darkShot(window, "nested.png");

  await dragBy(window, window.getByTestId("node-prompt-1"), 420, 160);

  await expect.poll(() => parentIn(window, "prompt-1")).toBeUndefined();
  await expect(window.getByTestId("node-issue-loop-1")).toHaveText(
    "Has no prompt or agent in its body.",
  );

  await window.getByTestId(controlTestIds.undo).click();
  await expect.poll(() => parentIn(window, "prompt-1")).toBe("loop-1");
});

test("Dragging a Loop moves its body with it", async () => {
  seed(flow([at(loop("L"), 120, 120), at(prompt("P", { parent: "L" }), 140, 200)], []));
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
  seed(flow([at(loop("L"), 120, 120), at(prompt("P", { parent: "L" }), 340, 200)], []));
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
    flow(
      [
        at(script("A"), 0, 120),
        at(loop("L"), 260, 120),
        at(prompt("P", { parent: "L" }), 260, 200),
        at(script("B"), 560, 120),
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

test("A fresh Loop says on the canvas that its body needs a Prompt or Agent", async () => {
  seed(flow([], []));
  const window = await launch();

  await dropOn(window, "loop", 500, 300);

  const issue = window.getByTestId("node-issue-loop-1");
  await expect(issue).toHaveText("2 problems");
  await expect(issue).toHaveAttribute(
    "title",
    "Write when the loop is done.\nHas no prompt or agent in its body.",
  );
  await expect(window.getByText("LOOP · max 3")).toBeVisible();
});

test("A File wire named plan.md draws dashed with its name and survives a reload", async () => {
  seed(
    flow(
      [at(sh("plan", "Planner", "true"), 80, 160), at(sh("build", "Builder", "true"), 420, 160)],
      [thenWire("plan", "build")],
    ),
  );
  let window = await launch();
  await window.getByTestId("node-plan").hover();

  await connectPorts(
    window,
    window.getByTestId("port-plan-file-out"),
    window.getByTestId("port-build-file-in"),
  );
  await expect(window.getByTestId("file-name-form")).toBeVisible();
  await window.getByTestId("file-name-input").fill("plan.md");
  await window.getByTestId("file-name-input").press("Enter");

  const label = window.getByTestId("file-wire-plan-build-plan.md");
  await expect(label).toHaveText("plan.md");
  await expect(window.getByTestId("file-name-form")).toHaveCount(0);
  expect((await readout(window)).wires).toContainEqual(fileWire("plan", "build", "plan.md"));
  const path = window.locator(
    '[data-testid="rf__edge-plan:file-out->build:file-in:plan.md"] path.react-flow__edge-path',
  );
  await expect(path).toHaveCSS("stroke-dasharray", "6px, 4px");

  await window.getByTestId(controlTestIds.save).click();
  window = await relaunch();

  await expect(window.getByTestId("file-wire-plan-build-plan.md")).toHaveText("plan.md");
  expect((await readout(window)).wires).toContainEqual(fileWire("plan", "build", "plan.md"));
  await darkShot(window, "file-wire.png");
});

test("A script-only run holds the next node on its File wire until the file is written", async () => {
  seed(
    flow(
      [
        at(sh("plan", "Planner", "if [ -f go ]; then echo '- one' > plan.md; fi"), 80, 160),
        at(sh("build", "Builder", "cat plan.md > built.txt"), 420, 160),
      ],
      [thenWire("plan", "build"), fileWire("plan", "build", "plan.md")],
    ),
  );
  const window = await launch();

  await window.getByTestId(controlTestIds.run).click();

  await expect(window.getByTestId("node-reason-build")).toHaveText(
    "plan.md wasn't written by Planner",
    { timeout: 20_000 },
  );
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("failed");
  const failedRun = latestRunId();
  expect(kindsOf(failedRun, "plan")).toEqual(["running", "done"]);
  expect(kindsOf(failedRun, "build")).toEqual(["running", "failed"]);
  expect(await exists(join(folder, "built.txt"))).toBe(false);

  await writeFile(join(folder, "go"), "");
  await window.getByTestId(pageTestIds.runAgain).click();

  await expect.poll(() => latestRunId(), { timeout: 20_000 }).not.toBe(failedRun);
  await expect(status(window, "build")).toHaveAttribute("data-status", "done", {
    timeout: 20_000,
  });
  expect(kindsOf(latestRunId(), "build")).toEqual(["running", "done"]);
  expect(await exists(join(folder, "built.txt"))).toBe(true);
});

for (const container of ["loop", "foreach"] as const) {
  test(`A ${container === "loop" ? "Loop" : "For each"} drawn in the app runs to done from Build & run`, async () => {
    await writeFile(join(folder, "items.txt"), "- alpha\n- bravo\n");
    seed(flow([], []));
    const window = await launch();
    await dropOn(window, container, 420, 260);
    const id = `${container}-1`;
    await dropInFrame(window, "prompt", window.getByTestId(`${container}-frame-${id}`));
    await expect.poll(() => parentIn(window, "prompt-1")).toBe(id);
    if (container === "loop") {
      await window.getByTestId(`node-${id}`).click();
      await window.getByTestId("node-setting-condition").fill("The work is done.");
      await window.getByTestId("node-setting-condition").blur();
    }
    await window.getByTestId("node-prompt-1").click();
    await window.getByTestId("node-setting-instructions").fill("Say done.");
    await window.getByTestId("node-setting-instructions").blur();
    await expect(window.getByTestId(`node-issue-${id}`)).toHaveCount(0);
    await expect(window.getByTestId("node-issue-prompt-1")).toHaveCount(0);

    await window.getByTestId(controlTestIds.run).click();

    await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
      timeout: 30_000,
    });
    await expect(status(window, id)).toHaveAttribute("data-status", "done");
    await expect(status(window, "prompt-1")).toHaveAttribute("data-status", "done");
    const rounds = kindsOf(latestRunId(), id).filter((kind) => kind === "round");
    expect(rounds).toHaveLength(container === "loop" ? 1 : 2);
  });
}
