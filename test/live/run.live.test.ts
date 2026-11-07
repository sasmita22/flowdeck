import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const fixturePath = fileURLToPath(new URL("../fixtures/run-live-flow.json", import.meta.url));
const runDeadlineMs = 240_000;
const transcriptSettleMs = 10_000;
const promptIds = ["p1", "p2", "p3"];
const buildName = "live-run";

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

type Entry = {
  type?: string;
  message?: { content?: unknown; stop_reason?: string | null };
};

type Outcome = { status: string; progress: string[] };

function turnSequence(entries: Entry[], prefix: string): string[] {
  const tokens: string[] = [];
  for (const entry of entries) {
    const content = JSON.stringify(entry.message?.content ?? "");
    const command = /<command-name>\/([^<]+)<\/command-name>/.exec(content);
    if (entry.type === "user" && command) tokens.push(`command ${command[1]}`);
    if (entry.type === "assistant" && entry.message?.stop_reason === "end_turn") {
      if (tokens.at(-1) !== "end_turn") tokens.push("end_turn");
    }
  }
  return tokens.filter((token) => token === "end_turn" || token.startsWith(`command ${prefix}:`));
}

function expectOneTurnPerPromptInOrder(
  entries: Entry[],
  prefix: string,
  pieces: ReadonlyMap<string, string>,
): void {
  expect(turnSequence(entries, prefix)).toEqual(
    promptIds.flatMap((id) => [`command ${prefix}:${pieces.get(id) ?? ""}`, "end_turn"]),
  );
}

function expectOnlyOkWritten(porcelain: string): void {
  expect(porcelain.split("\n").filter((line) => line !== "")).toEqual(["?? ok.txt"]);
}

async function readTranscript(path: string): Promise<Entry[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Entry);
}

async function settledTranscript(path: string, prefix: string): Promise<Entry[]> {
  const deadline = Date.now() + transcriptSettleMs;
  let entries = await readTranscript(path);
  while (turnSequence(entries, prefix).length < promptIds.length * 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    entries = await readTranscript(path);
  }
  return entries;
}

const snippet = (value: unknown) => JSON.stringify(value).slice(0, 160);

function describeEntry(entry: Entry): string {
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const tools = blocks.filter((block) => block.type === "tool_use").map((block) => block.name);
  const text =
    typeof content === "string"
      ? content
      : blocks.map((block) => block.text ?? block.content ?? "").join(" ");
  return `${entry.type} stop=${entry.message?.stop_reason ?? "-"} tools=[${tools.join(",")}] ${snippet(text)}`;
}

async function diagnostics(
  outcome: Outcome,
  porcelain: string,
  projectFolder: string,
): Promise<string> {
  const lines = [
    `run ended ${outcome.status}`,
    `progress:\n${outcome.progress.join("\n")}`,
    `git status --porcelain:\n${porcelain}`,
  ];
  for (const transcript of await transcriptsIn(projectFolder)) {
    const entries = await readTranscript(join(projectFolder, transcript));
    lines.push(`last entries of ${transcript}:`, ...entries.slice(-20).map(describeEntry));
  }
  return lines.join("\n");
}

async function transcriptsIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a run with real claude", () => {
  const sessionName = `fd-live-run-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
  });

  afterEach(async () => {
    try {
      const { stdout } = await run("tmux", [
        "-L",
        sessionName,
        "capture-pane",
        "-p",
        "-t",
        `=${sessionName}:`,
      ]);
      console.error(`pane of ${sessionName} before cleanup:\n${stdout}`);
    } catch (error) {
      if (!hasCode(error, 1)) throw error;
    }
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "runs three prompts one turn each, in order, writing only ok.txt",
    { timeout: runDeadlineMs + 60_000 },
    async () => {
      const fixture = parseFlow(JSON.parse(await readFile(fixturePath, "utf8")));
      const flow = {
        ...fixture,
        nodes: fixture.nodes.map((node) =>
          node.type === "prompt"
            ? {
                ...node,
                settings: {
                  instructions: node.settings.instructions.replaceAll("{{repo}}", "."),
                },
              }
            : node,
        ),
      };
      engine = liveEngine({ home, repo: repo.path, sessionName });
      const { buildId, workFolder } = await engine.saveAndBuild(flow, {
        name: buildName,
        values: { ticket: "FD-1" },
      });
      const projectFolder = join(
        homedir(),
        ".claude",
        "projects",
        workFolder.replace(/[^a-zA-Z0-9]/g, "-"),
      );

      const runId = await engine.runBuild(buildId);
      const status = await engine.waitForRunEnd(runId, runDeadlineMs);
      const progress = engine.stores.runs
        .events(runId)
        .filter((event) => promptIds.includes(event.nodeId))
        .filter((event) => event.kind === "sent" || event.kind === "done")
        .map((event) => `${event.nodeId} ${event.kind === "sent" ? "started" : "done"}`);

      const porcelain = (await run("git", ["status", "--porcelain"], { cwd: workFolder })).stdout;
      const transcripts = await transcriptsIn(projectFolder);
      const entries =
        transcripts.length === 1
          ? await settledTranscript(join(projectFolder, transcripts[0] ?? ""), buildName)
          : [];
      try {
        expect(status).toBe("done");
        expect(progress).toEqual(promptIds.flatMap((id) => [`${id} started`, `${id} done`]));
        expectOnlyOkWritten(porcelain);
        expect(transcripts).toHaveLength(1);
        expectOneTurnPerPromptInOrder(entries, buildName, pieceNames(flow));
      } catch (error) {
        console.error(await diagnostics({ status, progress }, porcelain, projectFolder));
        throw error;
      }
    },
  );
});
