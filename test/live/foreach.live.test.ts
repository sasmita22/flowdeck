import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import type { TranscriptTurn } from "../../src/core/run/resume.js";
import type { StoredEvent } from "../../src/core/run/store.js";
import type { TurnEndEvent, TurnEvents } from "../../src/core/run/turns.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { flow, forEach, output, prompt, thenWire, trigger } from "../fixtures/flow-builders.js";
import { killTmuxServer, removeClaudeSessions } from "../fixtures/live-claude.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const watchdogMs = 240_000;
const runTimeoutMs = 300_000;
const longItem = `${"Check the long third unit of this plan and keep reading to its very end. ".repeat(4)}zulu-3`;
const tokens = ["alpha-1", "bravo-2", "zulu-3"];
const planText = `- alpha-1\n- bravo-2\n- ${longItem}\n`;

function forEachFlow() {
  const parsed = flow(
    [
      trigger("t"),
      forEach("each"),
      prompt("p1", {
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

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("for each with real claude", () => {
  const sessionName = `fd-live-foreach-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let sessionIds: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    sessionIds = [];
  });

  afterEach(async () => {
    await killTmuxServer(sessionName);
    await removeClaudeSessions(repo.path, sessionIds);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "runs the body once per plan.md item, in order, each turn carrying only its own item",
    { timeout: runTimeoutMs },
    async () => {
      expect(longItem.length).toBeGreaterThan(290);
      await writeFile(join(repo.path, "plan.md"), planText);
      const built = await build(forEachFlow(), {
        fs: new NodeFileSystem(),
        home,
        hooks: { nodePath: process.execPath, hookScriptPath },
      });
      if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);

      const real = realDeps();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const stops: TurnEndEvent[] = [];
      let events: TurnEvents | undefined;
      let stopRun: ((exitCode: number) => void) | undefined;
      const deps: CliDeps = {
        ...real,
        env: { ...process.env, FLOWDECK_HOME: home },
        stdout: (line) => {
          stdout.push(line);
          console.log(`cli: ${line}`);
        },
        stderr: (line) => {
          stderr.push(line);
          console.error(`cli: ${line}`);
        },
        onInterrupt: (handler) => {
          stopRun = handler;
          return () => {
            stopRun = undefined;
          };
        },
        waiter: new FakeWaiter([]),
        startEvents: async (socketPath) => {
          const started = await real.startEvents(socketPath);
          events = started.events;
          return started;
        },
        openSession: async (options) => {
          const opened = await real.openSession(options);
          sessionIds.push(opened.sessionId);
          events?.subscribe("Stop", opened.sessionId, (event) => stops.push(event));
          return opened;
        },
      };

      const slug = repo.path.replace(/[^a-zA-Z0-9]/g, "-");
      const projectFolder = join(homedir(), ".claude", "projects", slug);
      const code = await withWatchdog(
        runCli(
          ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
          deps,
        ),
        watchdogMs,
        async () => {
          const transcripts = await Promise.all(
            sessionIds.map((id) => transcriptTail(join(projectFolder, `${id}.jsonl`))),
          );
          console.error(
            [
              `watchdog fired after ${watchdogMs} ms`,
              `pane:\n${await paneText(sessionName, sessionName)}`,
              ...transcripts.map((lines) => `transcript tail:\n${lines.join("\n")}`),
            ].join("\n"),
          );
          stopRun?.(1);
        },
      );

      const runId = stderr.map((line) => /^run (\S+)/.exec(line)?.[1]).find(Boolean);
      const store = new SqliteStore({ path: join(home, "flowdeck.db") });
      const runEvents: StoredEvent[] = runId === undefined ? [] : store.events(runId);
      const run = runId === undefined ? undefined : store.findRun(runId);
      store.close();
      const turns: TranscriptTurn[] = (
        await Promise.all(sessionIds.map((id) => real.transcriptTurns(id)))
      ).flat();
      const p1Turns = turns.filter((turn) => turn.userText.includes(`${built.hash}:p1`));
      const replies = stops.map((event) => String(event.payload["last_assistant_message"]));
      console.log(
        [
          `hash: ${built.hash}`,
          `exit: ${code}`,
          `run: ${JSON.stringify(run)}`,
          `stdout:\n${stdout.join("\n")}`,
          `stderr:\n${stderr.join("\n")}`,
          `run events:\n${runEvents.map((event) => `${event.time} ${event.nodeId} ${event.kind} ${JSON.stringify("payload" in event ? event.payload : {})}`).join("\n")}`,
          `hook events in order:\n${stops.map(describeHook).join("\n")}`,
          ...turns.map(
            (turn, i) =>
              `turn ${i + 1}:\n  user: ${turn.userText}\n  reply: ${turn.lastAssistantText ?? ""}`,
          ),
        ].join("\n"),
      );

      expect.soft(code).toBe(0);
      expect.soft(run?.status).toBe("done");
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
