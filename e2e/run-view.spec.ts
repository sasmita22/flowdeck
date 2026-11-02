import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "../src/adapters/node-fs/node-file-system.js";
import { SqliteFlowStore } from "../src/adapters/sqlite/flows.js";
import { openDatabase } from "../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../src/adapters/sqlite/sqlite-store.js";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { buildVersion } from "../src/core/compiler/build-version.js";
import { FakeConnectorSource } from "../test/fakes/fake-connector-source.js";
import {
  agent,
  branch,
  flow,
  fork,
  gate,
  join as joinNode,
  prompt,
  script,
  thenWire,
  trigger,
  wire,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint, seedFlow } from "../test/fixtures/seed-flow.js";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const laidOut = (nodes: unknown[], wires: unknown[]) =>
  flow(
    nodes.map((node, index) => ({
      ...(node as object),
      position: { x: index * 240, y: (index % 2) * 120 },
    })),
    wires,
  );

const run = promisify(execFile);

let home: string;
let folder: string;
let bin: string;
let launched: LaunchedApp | undefined;

const sh = (id: string, command: string, label = id) => ({
  ...script(id, { settings: { command: "sh", args: ["-c", command] } }),
  label,
});

const fakeClaude = `
const sock = process.env.FLOWDECK_SOCK ?? "";
const session = sock.slice(sock.lastIndexOf("/") + 1).replace(/\\.sock$/, "");
let typed = "";
const draw = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[HFake Claude in " + session + "\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n",
  );
process.stdout.on("resize", draw);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const key of chunk) {
    if (key === "\\r" || key === "\\n") typed = "";
    else if (key === "\\x7f") typed = typed.slice(0, -1);
    else if (key !== "\\x1b") typed += key;
  }
  draw();
});
draw();
`;

const launch = async (env: Record<string, string> = {}) => {
  launched = await launchApp({ home, logPath: test.info().outputPath("app.log"), env });
  await expect(launched.window.getByTestId(controlTestIds.run)).toBeVisible();
  return launched.window;
};

const withFakeClaude = async () => {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-claude.cjs")}"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  return launch({ PATH: `${bin}:${process.env["PATH"] ?? ""}` });
};

const closeApp = async () => {
  const previous = launched;
  launched = undefined;
  await previous?.close();
};

const rows = <T>(sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const latestRun = () =>
  rows<{ id: string; status: string; inputs: string; tmux_name: string }>(
    `SELECT runs.id, runs.status, runs.inputs, run_sessions.tmux_name
       FROM runs JOIN run_sessions ON run_sessions.run_id = runs.id
      ORDER BY runs.created_at DESC, runs.rowid DESC LIMIT 1`,
  )[0];

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

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
    await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
  }
};

const status = (window: Page, nodeId: string) => window.getByTestId(`node-status-${nodeId}`);

const darkShot = async (window: Page, name: string) => {
  await window.emulateMedia({ colorScheme: "dark" });
  await window.screenshot({ path: test.info().outputPath(name) });
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rv-"));
  folder = await realpath(await mkdtemp(join(tmpdir(), "fd-rv-wf-")));
  bin = join(home, "bin");
});

test.afterEach(async () => {
  try {
    await closeApp();
  } finally {
    await killTmux();
    await rm(home, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

test("A script that exits 3 says so on its node and in the inspector, and Retry after the fix goes on to done", async () => {
  await writeFile(join(folder, "code.txt"), "3");
  seedFlow(
    home,
    laidOut(
      [sh("s1", "exit $(cat code.txt)", "Run tests"), sh("s2", "echo shipped", "Ship")],
      [thenWire("s1", "s2")],
    ),
    folder,
  );
  const window = await launch();

  await window.getByTestId(controlTestIds.run).click();

  await expect(window.getByTestId("node-reason-s1")).toHaveText("Script exited with code 3", {
    timeout: 20_000,
  });
  await expect(window.getByTestId("inspector-reason-s1")).toHaveText("Script exited with code 3");
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("failed");
  await darkShot(window, "failed.png");

  await writeFile(join(folder, "code.txt"), "0");
  await window.getByTestId("retry-s1").click();

  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");
  await expect(window.getByTestId("node-reason-s1")).toHaveCount(0);
  const runId = latestRun()?.id;
  expect(
    rows<{ kind: string }>(
      "SELECT kind FROM events WHERE run_id = ? AND node_id = 's1' ORDER BY seq",
      runId,
    ).map((row) => row.kind),
  ).toEqual(["running", "failed", "retry", "running", "done"]);
  expect(latestRun()?.status).toBe("done");
});

test("Stop ends a long script and marks the run stopped, and Resume skips the finished nodes", async () => {
  seedFlow(
    home,
    laidOut(
      [
        sh("s1", "echo once >> s1.log"),
        sh("s2", "echo $$ > s2.pid; test -f go || exec sleep 60"),
        sh("s3", "echo last"),
      ],
      [thenWire("s1", "s2"), thenWire("s2", "s3")],
    ),
    folder,
  );
  const window = await launch();
  await window.getByTestId(controlTestIds.run).click();
  await expect(status(window, "s2")).toHaveAttribute("data-status", "running", {
    timeout: 20_000,
  });
  const pidText = () => readFile(join(folder, "s2.pid"), "utf8").catch(() => "");
  await expect.poll(pidText).toMatch(/^\d+\n$/);
  const pid = Number(await pidText());

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  expect(latestRun()?.status).toBe("stopped");
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch {
        return "gone";
      }
    })
    .toBe("gone");

  await writeFile(join(folder, "go"), "");
  await window.getByTestId(pageTestIds.runResume).click();

  await expect(status(window, "s3")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");
  expect(await readFile(join(folder, "s1.log"), "utf8")).toBe("once\n");
  expect(
    rows<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE run_id = ? AND node_id = 's1' AND kind = 'running'",
      latestRun()?.id,
    ),
  ).toEqual([{ n: 1 }]);
});

test("A skippable Gate is passed in an automatic run and stops in a normal one, chosen in the Run dialog", async () => {
  seedFlow(
    home,
    laidOut(
      [
        sh("s1", "echo one"),
        gate("g1", { settings: { shown: "Check the plan", skippable: true } }),
        sh("s2", "echo two"),
      ],
      [thenWire("s1", "g1"), thenWire("g1", "s2")],
    ),
    folder,
  );
  const window = await launch();

  await window.getByTestId(controlTestIds.run).click();
  const dialog = window.getByTestId("run-dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText(
    "Skips gates marked ‘skip in automatic runs’. Hard stops still stop.",
  );
  await window.getByTestId("run-dialog-auto").check();
  await darkShot(window, "run-dialog.png");
  await window.getByTestId("run-dialog-start").click();

  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(status(window, "g1")).toHaveAttribute("data-status", "skipped");
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({ auto: true });

  await window.getByTestId(pageTestIds.runAgain).click();
  await expect(dialog).toBeVisible();
  await expect(window.getByTestId("run-dialog-auto")).not.toBeChecked();
  await window.getByTestId("run-dialog-start").click();

  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });
  await expect(status(window, "g1")).toHaveAttribute("data-status", "needs you");
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({});
  await window.getByTestId("wait-approve").click();
  await expect(status(window, "s2")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
});

test("Turning a flag off for one run takes Branch's no path", async () => {
  seedFlow(
    home,
    laidOut(
      [
        trigger("t", { settings: { inputs: [], flags: { deep: true } } }),
        branch("b", "deep"),
        sh("yes", "echo deep"),
        sh("no", "echo quick"),
      ],
      [thenWire("t", "b"), wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
    ),
    folder,
  );
  const window = await launch();

  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId("run-dialog-flag-deep")).toBeChecked({ timeout: 20_000 });
  await window.getByTestId("run-dialog-flag-deep").uncheck();
  await window.getByTestId("run-dialog-start").click();

  await expect(status(window, "no")).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(status(window, "yes")).toHaveAttribute("data-status", "skipped");
  await expect(status(window, "t")).toHaveAttribute("data-status", "done");
  expect(JSON.parse(latestRun()?.inputs ?? "{}")).toEqual({ deep: false });
});

test("Script output shows in Activity and is still there after the run page is opened again", async () => {
  seedFlow(home, laidOut([sh("s1", "echo hello from s1; echo careful >&2")], []), folder);
  const window = await launch();

  await window.getByTestId(controlTestIds.run).click();
  const output = window.locator('[data-kind="output"][data-node-id="s1"]');
  await expect(output).toHaveText(["s1 Errors: careful", "s1 Output: hello from s1"], {
    timeout: 20_000,
  });
  const runId = latestRun()?.id ?? "";

  await window.getByTestId(pageTestIds.runBack).click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(output).toHaveText(["s1 Errors: careful", "s1 Output: hello from s1"]);

  await closeApp();
  const again = await launch();
  await again.getByTestId(controlTestIds.back).click();
  await again.getByTestId("menu-runs").click();
  await again.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(again.locator('[data-kind="output"][data-node-id="s1"]')).toHaveText([
    "s1 Errors: careful",
    "s1 Output: hello from s1",
  ]);
});

test("A gate's question shows on the run page while the inspector is hidden", async () => {
  seedFlow(
    home,
    laidOut(
      [sh("s1", "echo one"), gate("g1"), sh("s2", "echo two")],
      [thenWire("s1", "g1"), thenWire("g1", "s2")],
    ),
    folder,
  );
  const window = await launch();
  await window.getByTestId(controlTestIds.run).click();
  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });

  await window.getByTestId(controlTestIds.inspectorHide).click();

  await expect(window.getByTestId("inspector")).toHaveCount(0);
  const banner = window.getByTestId("wait-banner");
  await expect(banner).toBeVisible();
  await expect(banner.getByTestId("wait-text")).toHaveText("Check the plan");
  await expect(window.getByTestId("run-status")).toContainText("Needs you");
  await banner.getByTestId("wait-approve").click();
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
});

test("The Cost tab shows each node's tokens, cost and time, and a session line that adds them up", async () => {
  const source = seedBlueprint(
    home,
    "Plan and build",
    laidOut(
      [
        { ...prompt("p1"), label: "Plan" },
        sh("s1", "npm test", "Run tests"),
        { ...prompt("p2"), label: "Build" },
      ],
      [thenWire("p1", "s1"), thenWire("s1", "p2")],
    ),
    folder,
  );
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  let runId: string;
  try {
    let clock = Date.parse("2026-11-02T10:00:00Z");
    const runs = new SqliteStore({ db, now: () => new Date(clock) });
    const built = await buildVersion(source, {
      flows: new SqliteFlowStore({ db }),
      store: runs,
      fs: new NodeFileSystem(),
      home,
      connectors: new FakeConnectorSource(),
    });
    if (!built.ok) throw new Error("the seeded flow did not build");
    runId = runs.createRun({
      buildDir: built.dir,
      inputs: {},
      nodeIds: ["p1", "s1", "p2"],
      session: { tmuxName: "fd-run-seeded", cwd: folder, claudeSessionId: "seeded" },
      buildHash: built.hash,
    }).id;
    const at = (seconds: number, nodeId: string, event: Parameters<SqliteStore["append"]>[2]) => {
      clock = Date.parse("2026-11-02T10:00:00Z") + seconds * 1000;
      runs.append(runId, nodeId, event);
    };
    at(0, "p1", { kind: "sent" });
    at(42, "p1", { kind: "done" });
    at(43, "s1", { kind: "running" });
    at(51, "s1", { kind: "done" });
    at(52, "p2", { kind: "sent" });
    at(170, "p2", { kind: "done" });
    at(171, "p1", {
      kind: "usage",
      payload: { messages: ["m1", "m2"] },
      tokens: 48_210,
      cost: 0.18,
    });
    at(171, "p2", { kind: "usage", payload: { messages: ["m3"] }, tokens: 131_904, cost: 0.61 });
    runs.finishRun(runId, "done");
  } finally {
    db.close();
  }
  const window = await launch();
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-runs").click();
  await window.getByTestId(pageTestIds.runOpen(runId)).click();

  await window.getByTestId("run-tab-cost").click();

  await expect(window.getByTestId("cost-node-p1")).toHaveText(["Plan48.2k$0.1842s"]);
  await expect(window.getByTestId("cost-node-s1")).toHaveText(["Run tests0$0.008s"]);
  await expect(window.getByTestId("cost-node-p2")).toHaveText(["Build131.9k$0.611m 58s"]);
  await expect(window.getByTestId("cost-total")).toHaveText(["Session180.1k$0.792m 50s"]);
  await darkShot(window, "cost.png");
});

test("Fork and Join show their status during a parallel run, and Stop ends the run's tmux session", async () => {
  seedFlow(
    home,
    laidOut(
      [fork("f"), agent("a"), agent("b"), joinNode("j")],
      [thenWire("f", "a"), thenWire("f", "b"), thenWire("a", "j"), thenWire("b", "j")],
    ),
    folder,
  );
  const window = await withFakeClaude();

  await window.getByTestId(controlTestIds.run).click();

  await expect(status(window, "f")).toHaveAttribute("data-status", "sent", { timeout: 30_000 });
  await expect(status(window, "j")).toHaveAttribute("data-status", "running");
  await expect(status(window, "a")).toHaveAttribute("data-status", "sent");
  const session = latestRun()?.tmux_name ?? "";
  expect(await tmuxAlive(session)).toBe(true);

  await window.getByTestId(pageTestIds.runStop).click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
  await expect.poll(() => tmuxAlive(session)).toBe(false);
});

test("Pop out opens the terminal in its own window, attached to the run's session", async () => {
  seedFlow(home, laidOut([prompt("p1")], []), folder);
  const window = await withFakeClaude();
  await window.getByTestId(controlTestIds.run).click();
  await expect(status(window, "p1")).toHaveAttribute("data-status", "sent", { timeout: 30_000 });
  const session = latestRun()?.tmux_name ?? "";

  await window.getByTestId("run-tab-terminal").click();
  await expect(window.getByTestId("terminal-view")).toContainText(`Fake Claude in ${session}`, {
    timeout: 20_000,
  });
  await window.getByTestId("terminal-pop-out").click();

  await expect(window.getByTestId("terminal-popped-out")).toBeVisible();
  const app = launched?.app;
  if (app === undefined) throw new Error("the app is not running");
  const popOutText = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const popOut = BrowserWindow.getAllWindows().find(
        (each) => each.getTitle() === "Flowdeck terminal",
      );
      return popOut === undefined
        ? null
        : ((await popOut.webContents.executeJavaScript(
            "document.querySelector('[data-testid=terminal-view]')?.innerText ?? ''",
          )) as string);
    });
  await expect.poll(popOutText, { timeout: 20_000 }).toContain(`Fake Claude in ${session}`);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);

  await window.getByTestId(pageTestIds.runStop).click();
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("stopped", {
    timeout: 20_000,
  });
});
