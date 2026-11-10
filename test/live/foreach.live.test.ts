import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { parseTranscriptTurns } from "../../src/adapters/claude/transcript-turns.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import type { TranscriptTurn } from "../../src/core/run/resume.js";
import type { TurnEndEvent, TurnEvents } from "../../src/core/run/turns.js";
import { agent, flow, forEach, output, thenWire, trigger } from "../fixtures/flow-builders.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const watchdogMs = 240_000;
const runTimeoutMs = 300_000;
const buildName = "live-foreach";
const longItem = `${"Check the long third unit of this plan and keep reading to its very end. ".repeat(4)}zulu-3`;
const tokens = ["alpha-1", "bravo-2", "zulu-3"];
const planText = `- alpha-1\n- bravo-2\n- ${longItem}\n`;

function forEachFlow() {
  const parsed = flow(
    [
      trigger("t"),
      forEach("each"),
      agent("p1", {
        parent: "each",
        settings: { instructions: "Reply with only this round's item." },
      }),
      output("o"),
    ],
    [thenWire("t", "p1"), thenWire("p1", "o")],
  );
  return { ...parsed, session: { ...parsed.session, model: "haiku" } };
}

const describeHook = ({ sessionId, payload }: TurnEndEvent) =>
  `${String(payload["flowdeck_hook_at"])} Stop ${sessionId} ${String(payload["last_assistant_message"])}`;

async function transcriptTurns(sessionId: string): Promise<TranscriptTurn[]> {
  const path = await new ClaudeCli({ sessions: new TmuxSessionHost() }).findTranscript(sessionId);
  return path === undefined ? [] : parseTranscriptTurns(await readFile(path, "utf8"));
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("for each with real claude", () => {
  const sessionName = `fd-live-foreach-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "runs the body once per plan.md item, in order, each turn carrying only its own item",
    { timeout: runTimeoutMs },
    async () => {
      expect(longItem.length).toBeGreaterThan(290);
      const stops: TurnEndEvent[] = [];
      let events: TurnEvents | undefined;
      const live = liveEngine({
        home,
        repo: repo.path,
        sessionName,
        startEvents: (start) => async (socketPath) => {
          const started = await start(socketPath);
          events = started.events;
          return started;
        },
        openSession: (open) => async (options) => {
          const opened = await open(options);
          events?.subscribe("Stop", opened.sessionId, (event) => stops.push(event));
          return opened;
        },
      });
      engine = live;

      const built = await live.saveAndBuild(forEachFlow(), { name: buildName });
      await writeFile(join(built.workFolder, "plan.md"), planText);
      const slug = (await realpath(built.workFolder)).replace(/[^a-zA-Z0-9]/g, "-");
      const projectFolder = join(homedir(), ".claude", "projects", slug);
      const runId = await live.runBuild(built.buildId);
      const status = await withWatchdog(
        live.waitForRunEnd(runId, watchdogMs + 30_000),
        watchdogMs,
        async () => {
          const transcripts = await Promise.all(
            live.sessionIds.map((id) => transcriptTail(join(projectFolder, `${id}.jsonl`))),
          );
          console.error(
            [
              `watchdog fired after ${watchdogMs} ms`,
              `pane:\n${await paneText(sessionName, sessionName)}`,
              ...transcripts.map((lines) => `transcript tail:\n${lines.join("\n")}`),
            ].join("\n"),
          );
          await live.stopRun(runId);
        },
      );

      const runEvents = live.stores.runs.events(runId);
      const turns = (await Promise.all(live.sessionIds.map(transcriptTurns))).flat();
      const p1Turns = turns.filter((turn) => turn.userText.includes(`${buildName}:p1`));
      const replies = stops.map((event) => String(event.payload["last_assistant_message"]));
      console.log(
        [
          `hash: ${built.hash}`,
          `status: ${status}`,
          `run events:\n${runEvents.map((event) => `${event.time} ${event.nodeId} ${event.kind} ${JSON.stringify("payload" in event ? event.payload : {})}`).join("\n")}`,
          `hook events in order:\n${stops.map(describeHook).join("\n")}`,
          ...turns.map(
            (turn, i) =>
              `turn ${i + 1}:\n  user: ${turn.userText}\n  reply: ${turn.lastAssistantText ?? ""}`,
          ),
        ].join("\n"),
      );

      expect.soft(status).toBe("done");
      expect
        .soft(runEvents.filter((event) => event.nodeId === "each" && event.kind === "round"))
        .toHaveLength(3);
      expect.soft(p1Turns).toHaveLength(3);
      p1Turns.forEach((turn, i) => {
        tokens.forEach((token, j) => {
          if (i === j) expect.soft(turn.userText, `p1 turn ${i + 1}`).toContain(token);
          else expect.soft(turn.userText, `p1 turn ${i + 1}`).not.toContain(token);
        });
      });
      expect.soft(replies).toHaveLength(3);
      replies.forEach((reply, i) => {
        expect.soft(reply, `reply ${i + 1}`).toContain(tokens[i]);
      });
    },
  );
});
