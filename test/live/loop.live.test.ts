import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import type { StoredEvent } from "../../src/core/run/store.js";
import type { TurnEvents } from "../../src/core/run/turns.js";
import { paneText, transcriptTail, withWatchdog } from "../fixtures/live-evidence.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const watchdogMs = 240_000;
const buildName = "live-loop";
const runTimeoutMs = 300_000;
const condition = "every error the review reported is fixed";
const reviewText =
  "Run `node --check src/greet.js`, `node --check src/total.js` and `node --check src/math.js` as three separate Bash commands. Report each error with its file name and line. Do not change any file.";
const fixText =
  "Fix only the errors that the review earlier in this conversation reported, in the files it named. Do not run any command or open any other file. If there is no review earlier in this conversation, change nothing.";
const namesTheError = /\b(math|check|src)\b/i;

const files = {
  "src/greet.js":
    'function greet(name) {\n  return "hi " + name;\n}\nmodule.exports = { greet };\n',
  "src/total.js":
    "function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { total };\n",
  "src/math.js": "function add(a, b) {\n  return a + b;\n\nmodule.exports = { add };\n",
};

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow() {
  return parseFlow({
    nodes: [
      {
        id: "t",
        label: "Start",
        type: "trigger",
        position: at(0),
        settings: {},
      },
      {
        id: "l1",
        label: "Until fixed",
        type: "loop",
        position: at(1),
        settings: { condition, cap: 3, onCap: "fail" },
      },
      {
        id: "review",
        label: "Review",
        type: "prompt",
        position: at(2),
        parent: "l1",
        settings: { instructions: reviewText },
      },
      {
        id: "fix",
        label: "Fix",
        type: "prompt",
        position: at(3),
        parent: "l1",
        settings: { instructions: fixText },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(4),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "review"), then("review", "fix"), then("fix", "review"), then("fix", "o")],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [] },
      model: "haiku",
      allowedTools: ["Bash(node --check:*)"],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function nodeIn(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await run(process.execPath, args, { cwd });
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: unknown };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stderr: String(failed.stderr ?? ""),
    };
  }
}

const roundsOf = (events: StoredEvent[]) => {
  const rounds: string[][] = [];
  for (const event of events) {
    if (event.nodeId === "l1" && event.kind === "round") rounds.push([]);
    else if (event.kind === "done") rounds.at(-1)?.push(`${event.nodeId} done`);
  }
  return rounds;
};

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("loop nodes with real claude", () => {
  const sessionName = `fd-live-loop-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let claudeTmp: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    claudeTmp = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    if (claudeTmp !== undefined) await rm(claudeTmp, { recursive: true, force: true });
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "loops a reviewer and a fixer until the planted syntax error is fixed",
    { timeout: runTimeoutMs },
    async () => {
      const replies: string[] = [];
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
          events?.subscribe("Stop", opened.sessionId, (event) => {
            replies.push(String(event.payload["last_assistant_message"]));
          });
          return opened;
        },
      });
      engine = live;

      const flow = liveFlow();
      const built = await live.saveAndBuild(flow, { name: buildName });
      const { workFolder } = built;
      const slug = (await realpath(workFolder)).replace(/[^a-zA-Z0-9]/g, "-");
      claudeTmp = join("/private/tmp", `claude-${userInfo().uid}`, slug);
      const projectFolder = join(homedir(), ".claude", "projects", slug);
      await mkdir(join(workFolder, "src"));
      for (const [path, content] of Object.entries(files)) {
        await writeFile(join(workFolder, path), content);
      }
      const before = await nodeIn(workFolder, "--check", "src/math.js");
      console.log(`node --check src/math.js before: exit ${before.code}\n${before.stderr}`);
      expect(before.code).not.toBe(0);
      expect((await nodeIn(workFolder, "--check", "src/greet.js")).code).toBe(0);
      expect((await nodeIn(workFolder, "--check", "src/total.js")).code).toBe(0);
      expect(fixText).not.toMatch(namesTheError);
      expect(condition).not.toMatch(namesTheError);
      expect(
        await readFile(
          join(built.dir, "plugin", "skills", pieceNames(flow).get("fix") ?? "", "SKILL.md"),
          "utf8",
        ),
      ).not.toMatch(namesTheError);

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
      const rounds = roundsOf(runEvents);
      const loopProgress = runEvents
        .filter(
          (event) => event.nodeId === "l1" && (event.kind === "round" || event.kind === "done"),
        )
        .map((event) => (event.kind === "round" ? `l1 round ${event.payload.round}` : "l1 done"));
      const after = await nodeIn(workFolder, "--check", "src/math.js");
      const adds = await nodeIn(
        workFolder,
        "-e",
        "process.exit(require('./src/math.js').add(2, 3) === 5 ? 0 : 1)",
      );
      const math = await readFile(join(workFolder, "src/math.js"), "utf8");
      console.log(
        [
          `hash: ${built.hash}`,
          `status: ${status}`,
          `run events:\n${runEvents.map((event) => `${event.time} ${event.nodeId} ${event.kind}`).join("\n")}`,
          `rounds: ${rounds.length}`,
          ...replies.map((reply, i) => `reply ${i + 1}:\n${reply}`),
          `node --check src/math.js after: exit ${after.code}\n${after.stderr}`,
          `add(2, 3) === 5: exit ${adds.code}`,
          `src/math.js after:\n${math}`,
        ].join("\n"),
      );

      expect.soft(status).toBe("done");
      expect.soft(loopProgress).toContain("l1 round 1");
      expect.soft(rounds.length).toBeGreaterThanOrEqual(1);
      expect.soft(rounds.length).toBeLessThanOrEqual(3);
      for (const round of rounds) {
        expect.soft(round).toContain("review done");
        expect.soft(round).toContain("fix done");
      }
      expect.soft(loopProgress.at(-1)).toBe("l1 done");
      expect.soft(after.code, "node --check src/math.js passes").toBe(0);
      expect.soft(adds.code, "add(2, 3) is 5").toBe(0);
    },
  );
});
