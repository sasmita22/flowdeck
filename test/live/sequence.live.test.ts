import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runTwoTurns } from "../../scripts/two-turns.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

async function claudeRunning(sessionId: string): Promise<boolean> {
  try {
    await run("pgrep", ["-f", `session-id ${sessionId}`]);
    return true;
  } catch (error) {
    if (hasCode(error, 1)) return false;
    throw error;
  }
}

async function removeIfEmpty(folder: string): Promise<void> {
  try {
    await rmdir(folder);
  } catch (error) {
    if (!hasCode(error, "ENOTEMPTY", "ENOENT")) throw error;
  }
}

async function waitForClaudeToExit(sessionId: string): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
    if (!(await claudeRunning(sessionId))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`claude for session ${sessionId} did not exit`);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

type TranscriptEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  origin?: { kind?: string };
  message?: { content?: unknown; stop_reason?: string };
};

async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  const text = (await readIfPresent(path)) ?? "";
  const lines = text.split("\n").slice(0, -1);
  return lines.map((line) => JSON.parse(line) as TranscriptEntry);
}

const isHumanPrompt = (entry: TranscriptEntry) =>
  entry.type === "user" &&
  entry.origin?.kind === "human" &&
  typeof entry.message?.content === "string";

const isEndTurn = (entry: TranscriptEntry) =>
  entry.type === "assistant" && entry.message?.stop_reason === "end_turn";

const isSystem = (subtype: string) => (entry: TranscriptEntry) =>
  entry.type === "system" && entry.subtype === subtype;

async function transcriptWithTwoTurns(path: string): Promise<TranscriptEntry[]> {
  const deadline = Date.now() + 5000;
  let entries = await readTranscript(path);
  while (entries.filter(isSystem("turn_duration")).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    entries = await readTranscript(path);
  }
  return entries;
}

function turnProblems(entries: TranscriptEntry[]): string[] {
  const problems: string[] = [];
  const prompts = entries.filter(isHumanPrompt);
  const durations = entries.filter(isSystem("turn_duration"));
  const summaries = entries.filter(isSystem("stop_hook_summary"));
  if (prompts.length !== 2) problems.push(`${prompts.length} human prompts, not 2`);
  if (new Set(prompts.map((entry) => entry.promptId)).size !== prompts.length) {
    problems.push("the human prompts share a promptId");
  }
  if (durations.length !== 2) problems.push(`${durations.length} turn_duration entries, not 2`);
  if (summaries.length !== 2) {
    problems.push(`${summaries.length} stop_hook_summary entries, not 2`);
  }
  const [a, b] = prompts;
  const [aDuration] = durations;
  if (!a || !b || !aDuration) return problems;
  const aIndex = entries.indexOf(a);
  const aEnd = entries.findIndex((entry, index) => index > aIndex && isEndTurn(entry));
  if (aEnd === -1 || aEnd > entries.indexOf(b)) {
    problems.push("B's prompt comes before A's end_turn reply");
  }
  if (b.parentUuid !== aDuration.uuid) {
    problems.push("B's prompt is not parented on A's turn_duration");
  }
  return problems;
}

function withPromptBBeforeAEnd(entries: TranscriptEntry[]): TranscriptEntry[] {
  const [a, b] = entries.filter(isHumanPrompt);
  if (!a || !b) throw new Error("the transcript has fewer than two human prompts");
  const aEnd = entries.find((entry, index) => index > entries.indexOf(a) && isEndTurn(entry));
  if (!aEnd) throw new Error("the transcript has no end_turn reply after prompt A");
  const moved = entries.filter((entry) => entry !== b);
  moved.splice(moved.indexOf(aEnd), 0, b);
  return moved;
}

type ContentBlock = { type?: string; name?: string; input?: { file_path?: unknown } };

function blocksOf(entry: TranscriptEntry): ContentBlock[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

const readsATxt = (entry: TranscriptEntry) =>
  entry.type === "assistant" &&
  blocksOf(entry).some(
    (block) =>
      block.type === "tool_use" &&
      block.name === "Read" &&
      typeof block.input?.file_path === "string" &&
      block.input.file_path.endsWith("/a.txt"),
  );

function promptBReadProblems(entries: TranscriptEntry[]): string[] {
  const b = entries.filter(isHumanPrompt)[1];
  if (!b) return ["there is no prompt B"];
  const bIndex = entries.indexOf(b);
  const bEnd = entries.findIndex((entry, index) => index > bIndex && isEndTurn(entry));
  if (bEnd === -1) return ["B's turn has no end_turn reply"];
  return entries.slice(bIndex, bEnd).some(readsATxt) ? [] : ["B's turn has no Read of a.txt"];
}

function handOffProblems(files: { a?: string; b?: string; token: string }): string[] {
  const problems: string[] = [];
  if (files.a?.trim() !== files.token) problems.push("a.txt does not hold the token");
  if (files.b?.trim() !== files.token) problems.push("b.txt does not hold the token");
  return problems;
}

function freshTokenProblems(first: string, second: string): string[] {
  return first === second ? ["the second run reused the first run's token"] : [];
}

async function readHandOff(repo: TmpRepo, token: string) {
  const a = await readIfPresent(join(repo.path, "a.txt"));
  const b = await readIfPresent(join(repo.path, "b.txt"));
  return { token, ...(a === undefined ? {} : { a }), ...(b === undefined ? {} : { b }) };
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("two turns with real claude", () => {
  let home: string;
  let repo: TmpRepo;
  let ran: { sessionId: string; socketName: string; transcriptPath: string }[];
  let firstToken: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    repo = await createTmpRepo();
    ran = [];
  });

  afterEach(async () => {
    for (const { sessionId, socketName, transcriptPath } of ran) {
      await waitForClaudeToExit(sessionId);
      await rm(transcriptPath, { force: true });
      await rm(join(dirname(transcriptPath), sessionId), { recursive: true, force: true });
      await removeIfEmpty(join(dirname(transcriptPath), "memory"));
      await removeIfEmpty(dirname(transcriptPath));
      for (const folder of ["session-env", "file-history"]) {
        await rm(join(homedir(), ".claude", folder, sessionId), { recursive: true, force: true });
      }
      const socketFolder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
      await rm(join(socketFolder, socketName), { force: true });
    }
    await repo.cleanup();
  }, 60_000);

  it(
    "AT-1 and AT-2: B is sent after A ends and copies A's token",
    { timeout: 300_000 },
    async () => {
      const result = await runTwoTurns({ home, cwd: repo.path, model: "haiku" });
      ran.push(result);
      firstToken = result.token;
      const entries = await transcriptWithTwoTurns(result.transcriptPath);
      const files = await readHandOff(repo, result.token);

      expect(turnProblems(entries)).toEqual([]);
      expect(result.stops.map((stop) => stop.sessionId)).toEqual([
        result.sessionId,
        result.sessionId,
      ]);
      expect(handOffProblems(files)).toEqual([]);
      expect(promptBReadProblems(entries)).toEqual([]);
      expect(promptBReadProblems(entries.filter((entry) => !readsATxt(entry)))).toEqual([
        "B's turn has no Read of a.txt",
      ]);
      expect(turnProblems(withPromptBBeforeAEnd(entries))).toContain(
        "B's prompt comes before A's end_turn reply",
      );
      expect(handOffProblems({ ...files, b: randomUUID() })).toEqual([
        "b.txt does not hold the token",
      ]);
    },
  );

  it("AT-3: a second run uses a fresh token", { timeout: 300_000 }, async () => {
    if (firstToken === undefined) throw new Error("the first run did not produce a token");

    const result = await runTwoTurns({ home, cwd: repo.path, model: "haiku" });
    ran.push(result);
    const files = await readHandOff(repo, result.token);

    expect(handOffProblems(files)).toEqual([]);
    expect(freshTokenProblems(firstToken, result.token)).toEqual([]);
    expect(freshTokenProblems(firstToken, firstToken)).toEqual([
      "the second run reused the first run's token",
    ]);
  });
});
