import { test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Flow } from "../src/core/flow/schema.js";

export const run = promisify(execFile);

export const toggleId = "blueprint-terminal-toggle";
export const paneId = "blueprint-terminal";

export const bpName = (id: string) => `fd-bp-${id}`;
const slugOf = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-");
const projectFolder = (home: string, id: string) =>
  join(homedir(), ".claude", "projects", slugOf(join(home, "bp-sessions", id)));

export const capture = async (name: string) =>
  (await run("tmux", ["-L", name, "capture-pane", "-p", "-t", `=${name}:`])).stdout;

export const readyForInput = (pane: string) =>
  !/trust this folder/.test(pane) && /^─{4}/m.test(pane) && /^❯/m.test(pane);

export const readout = async (window: Page) =>
  JSON.parse((await window.getByTestId("canvas-flow").textContent()) ?? "") as Flow;

export const readBlueprintOverSocket = (home: string, session: string) =>
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

const transcriptsOf = async (home: string, id: string) =>
  (await readdir(projectFolder(home, id)).catch(() => [])).filter((file) =>
    file.endsWith(".jsonl"),
  );

const assistantMessages = async (home: string, id: string) => {
  const messages: Record<string, unknown>[] = [];
  for (const transcript of await transcriptsOf(home, id)) {
    const lines = (await readFile(join(projectFolder(home, id), transcript), "utf8")).split("\n");
    for (const line of lines.filter((text) => text.trim() !== "")) {
      const message = (JSON.parse(line) as { message?: Record<string, unknown> }).message;
      if (message?.["role"] === "assistant" && typeof message["model"] === "string") {
        messages.push(message);
      }
    }
  }
  return messages;
};

export const modelsAndUsage = async (home: string, id: string) => {
  const models = new Set<string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const message of await assistantMessages(home, id)) {
    models.add(message["model"] as string);
    const used = (message["usage"] ?? {}) as Record<string, number | undefined>;
    usage.input += used["input_tokens"] ?? 0;
    usage.output += used["output_tokens"] ?? 0;
    usage.cacheRead += used["cache_read_input_tokens"] ?? 0;
    usage.cacheWrite += used["cache_creation_input_tokens"] ?? 0;
  }
  return { models: [...models], usage };
};

export const turnEnded = async (home: string, id: string) =>
  (await assistantMessages(home, id)).at(-1)?.["stop_reason"] === "end_turn";

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

export const removeTranscripts = async (home: string, id: string) => {
  const folder = projectFolder(home, id);
  for (const transcript of await transcriptsOf(home, id)) {
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

export const killTmux = async (name: string) => {
  await run("tmux", ["-L", name, "kill-server"]).catch(() => undefined);
  const sockets = join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${userInfo().uid}`);
  await rm(join(sockets, name), { force: true });
};

export const keepEvidence = async (
  home: string,
  id: string,
  window: Page | undefined,
  prefix = "",
) => {
  const info = test.info();
  const save = (name: string, text: string) =>
    writeFile(info.outputPath(prefix + name), text).catch(() => undefined);
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
  for (const transcript of await transcriptsOf(home, id)) {
    await copyFile(
      join(projectFolder(home, id), transcript),
      info.outputPath(prefix + transcript),
    ).catch(() => undefined);
  }
};
