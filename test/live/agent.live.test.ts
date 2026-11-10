import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { EventLog } from "../../src/adapters/jsonl/event-log.js";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { agentTurnText } from "../../src/core/nodes/agent/execute.js";
import type { HookEvent } from "../../src/ports/event-source.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const runTimeoutMs = 300_000;
const buildName = "live-agent";
const hookKinds = ["Stop", "PreToolUse", "PostToolUse", "SubagentStop"] as const;

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

type LogLine = { kind?: string; tool_name?: string | null; agent_type?: string | null };

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow(secret: string) {
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
        id: "p1",
        label: "Tell",
        type: "agent",
        position: at(1),
        settings: {
          role: "",
          instructions: `The secret word is ${secret}. Write it to secret.md, then reply with only the secret word.`,
          model: "haiku",
          tools: ["Read", "Write"],
        },
      },
      {
        id: "a1",
        label: "Notes",
        type: "agent",
        position: at(2),
        settings: {
          role: "",
          instructions:
            "Write a file notes.md whose only content is the secret word you were told. If you were not told one, write UNKNOWN.",
          model: "haiku",
          tools: ["Write"],
        },
      },
      {
        id: "p2",
        label: "Control",
        type: "agent",
        position: at(3),
        settings: {
          role: "",
          instructions:
            "Write a file control.md whose only content is the secret word in secret.md.",
          model: "haiku",
          tools: ["Read", "Write"],
        },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(4),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [
      then("t", "p1"),
      then("p1", "a1"),
      then("a1", "p2"),
      then("p2", "o"),
      {
        kind: "file",
        from: { node: "p1", port: "file-out" },
        to: { node: "p2", port: "file-in" },
        file: "secret.md",
      },
    ],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [] },
      model: "haiku",
      allowedTools: ["Read", "Write"],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function readOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readEventLog(path: string): Promise<LogLine[]> {
  const text = (await readOrMissing(path)) ?? "";
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line) as LogLine);
}

async function listRecursive(folder: string): Promise<string[]> {
  try {
    return await readdir(folder, { recursive: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

const describeEvent = ({ kind, payload }: HookEvent) =>
  [
    kind,
    payload["tool_name"],
    payload["agent_type"],
    kind === "PreToolUse" ? JSON.stringify(payload["tool_input"]) : undefined,
    kind === "PostToolUse" && payload["tool_name"] === "Agent"
      ? JSON.stringify(payload["tool_response"]).slice(0, 200)
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("agent nodes with real claude", () => {
  const sessionName = `fd-live-agent-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;
  let claudeTmp: string | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
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
    "runs the agent as a subagent that writes notes.md without the conversation's secret",
    { timeout: runTimeoutMs },
    async () => {
      const secret = `s${randomBytes(5).toString("hex")}`;

      const logPath = join(home, "runs", "agent", "events.jsonl");
      const recorded: HookEvent[] = [];
      let server: HookSocketServer | undefined;
      engine = liveEngine({
        home,
        repo: repo.path,
        sessionName,
        startEvents: (start) => async (socketPath) => {
          const started = await start(socketPath);
          server = started.events as HookSocketServer;
          return started;
        },
        openSession: (open) => async (options) => {
          const opened = await open(options);
          if (server === undefined) throw new Error("hook socket not started");
          new EventLog({ events: server, path: logPath, runId: "agent" }).watch(opened.sessionId);
          for (const kind of hookKinds) {
            server.subscribe(kind, opened.sessionId, (event) => recorded.push(event));
          }
          return opened;
        },
      });

      const flow = liveFlow(secret);
      const piece = pieceNames(flow).get("a1") ?? "";
      const built = await engine.saveAndBuild(flow, { name: buildName });
      claudeTmp = join(
        "/private/tmp",
        `claude-${userInfo().uid}`,
        built.workFolder.replace(/[^a-zA-Z0-9]/g, "-"),
      );
      const notesPath = join(built.workFolder, "notes.md");
      const controlPath = join(built.workFolder, "control.md");
      await rm(notesPath, { force: true });
      expect(await readOrMissing(notesPath)).toBeUndefined();
      expect(
        await readFile(join(built.dir, "plugin", "agents", `${piece}.md`), "utf8"),
      ).not.toContain(secret);
      expect(agentTurnText(buildName, piece, { id: "a1", given: [], writes: [] })).not.toContain(
        secret,
      );

      const runId = await engine.runBuild(built.buildId);
      const status = await engine.waitForRunEnd(runId, runTimeoutMs - 60_000);

      const progress = engine.stores.runs
        .events(runId)
        .filter((event) => ["p1", "a1", "p2"].includes(event.nodeId))
        .filter((event) => event.kind === "sent" || event.kind === "done")
        .map((event) => `${event.nodeId} ${event.kind === "sent" ? "started" : "done"}`);
      const notes = await readOrMissing(notesPath);
      const control = await readOrMissing(controlPath);
      const log = await readEventLog(logPath);
      console.log(
        [
          `secret: ${secret}`,
          `hash: ${built.hash}`,
          `status: ${status}`,
          `progress:\n${progress.join("\n")}`,
          `notes.md: ${JSON.stringify(notes)}`,
          `control.md: ${JSON.stringify(control)}`,
          `git status --porcelain:\n${(await run("git", ["status", "--porcelain"], { cwd: built.workFolder })).stdout}`,
          `files under ${claudeTmp}: ${JSON.stringify(await listRecursive(claudeTmp))}`,
          `hook events in order:\n${recorded.map(describeEvent).join("\n")}`,
        ].join("\n"),
      );

      expect.soft(status).toBe("done");
      expect
        .soft(progress)
        .toEqual(["p1 started", "p1 done", "a1 started", "a1 done", "p2 started", "p2 done"]);
      expect.soft(notes, "notes.md exists").toBeDefined();
      expect
        .soft(
          log.filter((line) => line.kind === "SubagentStop").map((line) => line.agent_type),
          "a SubagentStop for the build's agent",
        )
        .toContain(`${buildName}:${piece}`);
      expect
        .soft(
          recorded.some(
            (event) =>
              event.kind === "PostToolUse" &&
              event.payload["tool_name"] === "Agent" &&
              JSON.stringify(event.payload["tool_response"]).includes(secret),
          ),
          "positive control: Tell's reply puts the secret in the main session",
        )
        .toBe(true);
      expect.soft(notes ?? "", "the subagent does not know the secret").not.toContain(secret);
      expect
        .soft(control ?? "", "positive control: the File wire hands it to Control")
        .toContain(secret);
    },
  );
});
