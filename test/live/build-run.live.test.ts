import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { prepareKit } from "../../src/adapters/node-fs/kit-copy.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";
import type { RunEvent } from "../../src/core/run/run-events.js";
import type { HumanWaiter } from "../../src/core/run/wait.js";
import { killTmuxServer, removeClaudeSessions, sleep } from "../fixtures/live-claude.js";
import { paneText } from "../fixtures/live-evidence.js";
import {
  liveBuildAgents,
  liveEngine,
  sessionIdsIn,
  type LiveEngine,
} from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const kitSourceDir = fileURLToPath(new URL("../../kit", import.meta.url));
const buildTimeoutMs = 900_000;
const testTimeoutMs = 1_500_000;
const runDeadlineMs = 300_000;
const statusKinds = new Set<RunEvent["kind"]>([
  "sent",
  "running",
  "needs-you",
  "skipped",
  "failed",
  "done",
]);

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});
const fileWire = (from: string, to: string, file: string) => ({
  kind: "file",
  from: { node: from, port: "file-out" },
  to: { node: to, port: "file-in" },
  file,
});

type Step =
  | { type: "agent"; id: string; label: string; instructions: string; writes?: string[] }
  | { type: "prompt"; id: string; label: string; instructions: string; expectedOutput: string };

function liveFlow(steps: Step[], files: ReturnType<typeof fileWire>[]): Flow {
  const ids = ["t", ...steps.map((step) => step.id)];
  return parseFlow({
    nodes: [
      { id: "t", label: "Start", type: "trigger", position: at(0), settings: {} },
      ...steps.map((step, index) => ({
        id: step.id,
        label: step.label,
        type: step.type,
        position: at(index + 1),
        settings:
          step.type === "prompt"
            ? { instructions: step.instructions, expectedOutput: step.expectedOutput }
            : {
                role: "",
                instructions: step.instructions,
                model: "haiku",
                tools: ["Read", "Write"],
                ...(step.writes === undefined ? {} : { writes: step.writes }),
              },
      })),
    ],
    wires: [...ids.slice(1).map((id, index) => then(ids[index] ?? "", id)), ...files],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [], buildModel: "haiku" },
      model: "haiku",
      allowedTools: ["Read", "Write"],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function contentOrEmpty(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

function nodeRows(home: string, runId: string) {
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  try {
    const rows = db
      .prepare("SELECT node_id, finished_at FROM run_nodes WHERE run_id = ? ORDER BY rowid")
      .all(runId) as { node_id: string; finished_at: string | null }[];
    const events = new SqliteStore({ db }).events(runId);
    const statusOf = (nodeId: string) =>
      events.findLast((event) => event.nodeId === nodeId && statusKinds.has(event.kind))?.kind;
    return {
      rows: rows.map((row) => ({
        node: row.node_id,
        finished: row.finished_at !== null,
        status: statusOf(row.node_id),
      })),
      askedYou: events.filter((event) => event.kind === "needs-you").map((event) => event.nodeId),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("built flows run with real claude", () => {
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let socketName: string;
  let workFolder: string | undefined;

  const builds = (waiter?: HumanWaiter) => {
    const kit = prepareKit({ sourceDir: kitSourceDir, home });
    engine = liveEngine({
      home,
      repo: repo.path,
      sessionName: socketName,
      buildAgents: liveBuildAgents(home),
      kit: () => kit,
      buildTimeoutMs,
      ...(waiter === undefined ? {} : { waiter }),
    });
    return engine;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
    socketName = `fd-lt-${randomBytes(4).toString("hex")}`;
    workFolder = undefined;
  });

  afterEach(async () => {
    console.error(
      `pane of ${socketName} before cleanup:\n${await paneText(socketName, socketName)}`,
    );
    await killTmuxServer(socketName);
    if (workFolder !== undefined) {
      await removeClaudeSessions(workFolder, await sessionIdsIn(await realpath(workFolder)));
    }
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 120_000);

  describe("AT-24", () => {
    it(
      "runs a three-Agent flow built by the real agents to done through the engine, with no manual step",
      { timeout: testTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "agent",
              id: "a1",
              label: "Write greeting",
              instructions: "Write the single word hello to greeting.txt.",
              writes: ["greeting.txt"],
            },
            {
              type: "agent",
              id: "a2",
              label: "Shout greeting",
              instructions: "Read greeting.txt and write its word in capital letters to shout.txt.",
              writes: ["shout.txt"],
            },
            {
              type: "agent",
              id: "a3",
              label: "Count letters",
              instructions:
                "Read shout.txt and write the number of letters in its word to count.txt.",
              writes: ["count.txt"],
            },
          ],
          [fileWire("a1", "a2", "greeting.txt"), fileWire("a2", "a3", "shout.txt")],
        );
        const waits: unknown[] = [];
        const live = builds({
          wait: async (request) => {
            waits.push(request);
            return { decision: "stop", reason: "AT-24 allows no manual step" };
          },
        });
        const built = await live.saveAndBuild(flow, { name: "live-three" });
        expect(built.outcome.outcome).toBe("built");
        workFolder = built.workFolder;

        const runId = await live.runBuild(built.buildId);
        const status = await live
          .waitForRunEnd(runId, runDeadlineMs)
          .catch((error: unknown) => `not ended: ${String(error)}`);

        const { rows, askedYou } = nodeRows(home, runId);
        console.log(
          [
            `status: ${status}`,
            `run_nodes: ${JSON.stringify(rows)}`,
            `count.txt: ${JSON.stringify(await contentOrEmpty(join(workFolder, "count.txt")))}`,
          ].join("\n"),
        );
        expect(status).toBe("done");
        expect(rows.filter((row) => ["a1", "a2", "a3"].includes(row.node))).toEqual(
          ["a1", "a2", "a3"].map((node) => ({ node, finished: true, status: "done" })),
        );
        expect(waits).toEqual([]);
        expect(askedYou).toEqual([]);
      },
    );
  });

  describe("AT-14", () => {
    it(
      "runs /<build-name>:run in plain claude in the worktree, leaving every declared output and no hook error",
      { timeout: testTimeoutMs },
      async () => {
        const name = "live-plain";
        const flow = liveFlow(
          [
            {
              type: "prompt",
              id: "p1",
              label: "Write plan",
              instructions:
                'Write this one line to plan.md: "Plan: greet the user by name on the home page."',
              expectedOutput: "plan.md, one line naming the plan",
            },
            {
              type: "agent",
              id: "a1",
              label: "Expand plan",
              instructions:
                "Read plan.md and write to steps.md two numbered steps that carry out that plan.",
              writes: ["steps.md"],
            },
            {
              type: "agent",
              id: "a2",
              label: "Review steps",
              instructions:
                "Read steps.md and write to review.md one line: OK, or the one problem you see. The flow ends here; the line is a record and nothing acts on it.",
              writes: ["review.md"],
            },
          ],
          [fileWire("p1", "a1", "plan.md"), fileWire("a1", "a2", "steps.md")],
        );
        const built = await builds().saveAndBuild(flow, { name });
        expect(built.outcome.outcome).toBe("built");
        const folder = built.workFolder;
        console.log(
          [...built.files]
            .filter(
              ([path]) => path.startsWith("plugin/skills/") || path.startsWith("plugin/agents/"),
            )
            .map(([path, content]) => `== ${path}\n${content}`)
            .join("\n"),
        );
        workFolder = folder;
        const outputs = ["plan.md", "steps.md", "review.md"];
        const sessions = new TmuxSessionHost({ socketName });
        const cli = new ClaudeCli({ sessions });

        await sessions.start(
          socketName,
          folder,
          "claude --add-dir .. --settings ../settings.json --plugin-dir ../plugin --model haiku",
        );
        await cli.waitUntilReady(socketName);
        await cli.sendPrompt(socketName, `/${name}:run`);
        const written = async () =>
          (await Promise.all(outputs.map((file) => contentOrEmpty(join(folder, file))))).every(
            (content) => content !== "",
          );
        for (let waited = 0; waited < runDeadlineMs && !(await written()); waited += 1000) {
          await sleep(1000);
        }
        for (
          let waited = 0;
          waited < 60_000 && (await sessions.capture(socketName)).includes("esc to interrupt");
          waited += 1000
        ) {
          await sleep(1000);
        }

        const { stdout: scrollback } = await run("tmux", [
          "-L",
          socketName,
          "capture-pane",
          "-p",
          "-S",
          "-",
          "-t",
          `=${socketName}:`,
        ]);
        const contents = Object.fromEntries(
          await Promise.all(
            outputs.map(async (file) => [file, await contentOrEmpty(join(folder, file))] as const),
          ),
        );
        const { stdout: found } = await run("find", [
          built.dir,
          "-name",
          "*.md",
          "-newer",
          join(built.dir, "manifest.json"),
        ]);
        console.log(
          `outputs: ${JSON.stringify(contents)}\nmd files written after the build:\n${found}\nscrollback:\n${scrollback}`,
        );
        expect(outputs.filter((file) => contents[file] === "")).toEqual([]);
        expect(scrollback).not.toMatch(/hook error|hook failed|non-blocking status code/i);
      },
    );
  });
});
