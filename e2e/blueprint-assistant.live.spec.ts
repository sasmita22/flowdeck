import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import { flow, prompt } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { launchOnCanvas, type LaunchedApp } from "../scripts/drive.js";

const run = promisify(execFile);

const ask = "add a Script node that runs npm test after the planner";
const toggleId = "blueprint-terminal-toggle";
const paneId = "blueprint-terminal";
const agentDeadlineMs = 240_000;

let home: string;
let flowId: string | undefined;
let launched: LaunchedApp | undefined;

test.setTimeout(360_000);

const bpName = (id: string) => `fd-bp-${id}`;
const slugOf = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");
const projectFolder = (id: string) =>
  join(homedir(), ".claude", "projects", slugOf(join(home, "bp-sessions", id)));

const capture = async (name: string) =>
  (await run("tmux", ["-L", name, "capture-pane", "-p", "-t", `=${name}:`])).stdout;

const readyForInput = (pane: string) =>
  !/trust this folder/.test(pane) && /^─{4}/m.test(pane) && /^❯/m.test(pane);

const readout = async (window: Page) =>
  JSON.parse((await window.getByTestId("canvas-flow").textContent()) ?? "") as Flow;

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

const readBlueprintOverSocket = (session: string) =>
  new Promise<{ ok: boolean; unsaved?: boolean; flow?: Flow }>((resolve, reject) => {
    const socket = connect(join(home, "sockets", "bp.sock"));
    socket.setEncoding("utf8");
    let reply = "";
    socket.on("error", reject);
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => {
      try {
        resolve(JSON.parse(reply.slice(0, reply.indexOf("\n"))));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.write(
      JSON.stringify({ type: "call", name: "read_blueprint", input: {}, session }) + "\n",
    );
  });

const transcriptsOf = async (id: string) =>
  (await readdir(projectFolder(id)).catch(() => [])).filter((file) => file.endsWith(".jsonl"));

const modelsAndUsage = async (id: string) => {
  const models = new Set<string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const transcript of await transcriptsOf(id)) {
    const lines = (await readFile(join(projectFolder(id), transcript), "utf8")).split("\n");
    for (const line of lines.filter((text) => text.trim() !== "")) {
      const message = (JSON.parse(line) as { message?: Record<string, unknown> }).message;
      if (message?.["role"] !== "assistant" || typeof message["model"] !== "string") continue;
      models.add(message["model"]);
      const used = (message["usage"] ?? {}) as Record<string, number | undefined>;
      usage.input += used["input_tokens"] ?? 0;
      usage.output += used["output_tokens"] ?? 0;
      usage.cacheRead += used["cache_read_input_tokens"] ?? 0;
      usage.cacheWrite += used["cache_creation_input_tokens"] ?? 0;
    }
  }
  return { models: [...models], usage };
};

const claudeRunning = (sessionId: string) =>
  run("pgrep", ["-f", `session-id ${sessionId}`]).then(
    () => true,
    () => false,
  );

const waitForClaudeToExit = async (sessionId: string) => {
  for (let waited = 0; waited < 10_000; waited += 200) {
    if (!(await claudeRunning(sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`claude for session ${sessionId} did not exit`);
};

const removeTranscripts = async (id: string) => {
  const folder = projectFolder(id);
  for (const transcript of await transcriptsOf(id)) {
    const sessionId = transcript.replace(/\.jsonl$/, "");
    await waitForClaudeToExit(sessionId);
    await rm(join(folder, transcript), { force: true });
    await rm(join(folder, sessionId), { recursive: true, force: true });
    for (const kept of ["session-env", "file-history"]) {
      await rm(join(homedir(), ".claude", kept, sessionId), { recursive: true, force: true });
    }
  }
  for (const empty of [join(folder, "memory"), folder]) await rmdir(empty).catch(() => undefined);
};

const killTmux = async (name: string) => {
  await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
  const sockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);
  await rm(join(sockets, name), { force: true });
};

test.beforeEach(async () => {
  launched = undefined;
  flowId = undefined;
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-mt-ba-live-")));
  await writeFile(join(home, "claude.json"), JSON.stringify({ mcpServers: {} }));
});

const keepEvidence = async (id: string, window: Page | undefined) => {
  const info = test.info();
  const save = (name: string, text: string) =>
    writeFile(info.outputPath(name), text).catch(() => undefined);
  await save(
    "pane.txt",
    await run("tmux", ["-L", bpName(id), "capture-pane", "-p", "-S", "-", "-t", `=${bpName(id)}:`])
      .then(({ stdout }) => stdout)
      .catch((error: unknown) => String(error)),
  );
  if (window !== undefined) {
    await save(
      "canvas.json",
      (await window.getByTestId("canvas-flow").textContent().catch(String)) ?? "",
    );
  }
  for (const transcript of await transcriptsOf(id)) {
    await copyFile(join(projectFolder(id), transcript), info.outputPath(transcript)).catch(
      () => undefined,
    );
  }
};

test.afterEach(async () => {
  try {
    const failed = test.info().status !== test.info().expectedStatus;
    if (failed && flowId !== undefined) await keepEvidence(flowId, launched?.window);
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    if (flowId !== undefined) {
      await killTmux(bpName(flowId));
      await removeTranscripts(flowId);
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
  const answer = await readBlueprintOverSocket(bpName(id));
  expect(answer).toMatchObject({ ok: true, unsaved: true });
  expect(answer.flow && scriptAfterPlanner(answer.flow)?.id).toBe(added?.id);

  const { models, usage } = await modelsAndUsage(id);
  console.log(`agent pane:\n${await capture(bpName(id))}`);
  console.log(`models ${JSON.stringify(models)} usage ${JSON.stringify(usage)}`);
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model).toMatch(/haiku/);
});
