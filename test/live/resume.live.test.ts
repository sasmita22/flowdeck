import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { agent, onMainFlow, thenWire, withSession } from "../fixtures/flow-builders.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";
import { claudeConfigDir, useTempClaudeConfig } from "../fixtures/claude-config.js";

const buildName = "live-resume";
const watchdogMs = 180_000;
const transcriptSettleMs = 10_000;
const words = { p1: "ALPHA", p2: "BRAVO", p3: "CHARLIE" };

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sessionAlive = (name: string) => new TmuxSessionHost({ socketName: name }).has(name);

async function until<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(100);
  }
}

type Entry = {
  type?: string;
  isMeta?: boolean;
  message?: { content?: unknown; stop_reason?: string };
};

async function entriesOf(path: string): Promise<Entry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  return raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Entry];
    } catch {
      return [];
    }
  });
}

const agentCall = (prefix: string, piece: string) =>
  `Use the Agent tool with subagent_type "${prefix}:${piece}"`;

const userIndexes = (entries: Entry[], call: string) =>
  entries.flatMap((entry, i) => {
    const content = entry.message?.content;
    return entry.type === "user" &&
      entry.isMeta !== true &&
      typeof content === "string" &&
      content.startsWith(call)
      ? [i]
      : [];
  });

const endedAfter = (entries: Entry[], call: string) =>
  entries
    .slice((userIndexes(entries, call)[0] ?? entries.length) + 1)
    .some((entry) => entry.type === "assistant" && entry.message?.stop_reason === "end_turn");

async function settledEntries(path: string, call: string): Promise<Entry[]> {
  const deadline = Date.now() + transcriptSettleMs;
  let entries = await entriesOf(path);
  while (!endedAfter(entries, call) && Date.now() < deadline) {
    await sleep(250);
    entries = await entriesOf(path);
  }
  return entries;
}

const toolResult = (entries: Entry[], toolUseId: string) =>
  entries
    .flatMap((entry) => {
      const content = entry.message?.content;
      return Array.isArray(content)
        ? (content as { tool_use_id?: string; content?: unknown }[])
        : [];
    })
    .filter((block) => block.tool_use_id === toolUseId)
    .map((block) => JSON.stringify(block.content))
    .join("\n");

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")(
  "a run resumed by the engine with real claude",
  () => {
    useTempClaudeConfig();
    const sessionName = `fd-live-resume-${process.pid}`;
    let home: string;
    let repo: TmpRepo;
    let engines: LiveEngine[];
    let claudeTmp: string | undefined;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "fd-home-"));
      repo = await createTmpRepo({ commit: true });
      engines = [];
      claudeTmp = undefined;
    });

    afterEach(async () => {
      for (const engine of engines.reverse()) await engine.cleanup();
      if (claudeTmp !== undefined) await rm(claudeTmp, { recursive: true, force: true });
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
    }, 60_000);

    it(
      "resumes a run interrupted during node 2 without resending it, and runs node 3",
      { timeout: watchdogMs + 30_000 },
      async () => {
        const parsed = onMainFlow(
          (["p1", "p2", "p3"] as const).map((id) =>
            agent(id, { settings: { instructions: `Reply with the single word ${words[id]}.` } }),
          ),
          [thenWire("p1", "p2"), thenWire("p2", "p3")],
        );
        const prompts = withSession(parsed, { model: "haiku" });
        const pieces = pieceNames(prompts);
        const callOfNode = (id: string) => agentCall(buildName, pieces.get(id) ?? "");
        const typedTurn = (id: string) => `❯ ${callOfNode(id)}`;
        const first = liveEngine({ home, repo: repo.path, sessionName, sessionAlive });
        engines.push(first);
        const built = await first.saveAndBuild(prompts, { name: buildName });
        const slug = (await realpath(built.workFolder)).replace(/[^a-zA-Z0-9]/g, "-");
        claudeTmp = join("/private/tmp", `claude-${userInfo().uid}`, slug);
        const projectFolder = join(claudeConfigDir(), "projects", slug);
        let transcriptPath = "";
        let lastPane = "";
        const evidence = async () => {
          console.error(`pane:\n${await paneText(sessionName, sessionName)}`);
          console.error(`transcript tail:\n${(await transcriptTail(transcriptPath)).join("\n")}`);
        };

        const runId = await first.runBuild(built.buildId);
        const { runs } = first.stores;
        const claudeSessionId = await withWatchdog(
          until(() => runs.findRun(runId)?.session.claudeSessionId || undefined),
          30_000,
          evidence,
        );
        transcriptPath = join(projectFolder, `${claudeSessionId}.jsonl`);
        await withWatchdog(
          until(async () => {
            const sent = runs.events(runId).some((e) => e.nodeId === "p2" && e.kind === "sent");
            const delivered =
              userIndexes(await entriesOf(transcriptPath), callOfNode("p2")).length > 0;
            return sent && delivered ? true : undefined;
          }),
          120_000,
          evidence,
        );
        await first.detach();
        const statusAtDetach = runs.findRun(runId)?.status;

        const second = liveEngine({
          home,
          repo: repo.path,
          sessionName,
          sessionAlive,
          stores: first.stores,
        });
        engines.push(second);
        await second.handler.reattach();
        let ended = false;
        const polling = (async () => {
          while (!ended) {
            const pane = await paneText(sessionName, sessionName);
            if (!pane.startsWith("no pane")) lastPane = pane;
            await sleep(100);
          }
        })();
        const status = await withWatchdog(
          second.waitForRunEnd(runId, 150_000).finally(() => (ended = true)),
          150_000,
          evidence,
        ).finally(() => (ended = true));
        await polling;

        const entries = await settledEntries(transcriptPath, callOfNode("p3"));
        const p2Turns = userIndexes(entries, callOfNode("p2"));
        const p3Turns = userIndexes(entries, callOfNode("p3"));
        const p3Ended = endedAfter(entries, callOfNode("p3"));
        const p3Done = runs.events(runId).find((e) => e.nodeId === "p3" && e.kind === "done");
        const report = [
          `status at detach: ${statusAtDetach}`,
          `status: ${status}`,
          `run events:\n${runs
            .events(runId)
            .map((event) => `${event.time} ${event.nodeId} ${event.kind}`)
            .join("\n")}`,
          `last pane:\n${lastPane}`,
          `transcript tail:\n${(await transcriptTail(transcriptPath)).join("\n")}`,
        ].join("\n");

        const paneLines = lastPane.split("\n").map((line) => line.trim());
        expect(statusAtDetach, report).toBe("running");
        expect(status, report).toBe("done");
        expect(
          paneLines.filter((line) => line.startsWith(typedTurn("p3"))),
          report,
        ).toHaveLength(1);
        expect(p2Turns, report).toHaveLength(1);
        expect(p3Turns, report).toHaveLength(1);
        expect(p3Ended, report).toBe(true);
        expect(
          runs.events(runId).filter((e) => e.nodeId === "p2" && e.kind === "sent"),
          report,
        ).toHaveLength(1);
        expect(p3Done, report).toMatchObject({ payload: { toolUseIds: [expect.any(String)] } });
        const [p3Call = ""] = p3Done?.kind === "done" ? (p3Done.payload?.toolUseIds ?? []) : [];
        expect(toolResult(entries, p3Call), report).toContain(words.p3);
      },
    );
  },
);
