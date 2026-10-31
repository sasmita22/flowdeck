import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import type { StoredEvent } from "../../src/core/run/store.js";
import type { HookEvent } from "../../src/ports/event-source.js";
import { killTmuxServer, removeClaudeSessions } from "../fixtures/live-claude.js";
import {
  agent,
  flow,
  fork,
  join as joinNode,
  output,
  prompt,
  thenWire,
  trigger,
} from "../fixtures/flow-builders.js";
import { createTmpRepo } from "../fixtures/tmp-repo.js";

const hookScriptPath = fileURLToPath(new URL("../../bin/flowdeck-hook.ts", import.meta.url));
const runTimeoutMs = 420_000;
const hookKinds = ["Stop", "PreToolUse", "PostToolUse", "SubagentStop"] as const;

const sleeper = (id: string, seconds: number) =>
  agent(id, {
    settings: {
      role: "",
      instructions: `Run \`sleep ${seconds}\` with the Bash tool. Then reply DONE.`,
      model: "haiku",
      tools: ["Bash"],
    },
  });

function parallelFlow(seconds: Record<string, number>, wait: "all" | "first") {
  const branches = Object.keys(seconds);
  const parsed = flow(
    [
      trigger("t"),
      fork("f"),
      ...Object.entries(seconds).map(([id, sleep]) => sleeper(id, sleep)),
      joinNode("j", { settings: { wait } }),
      prompt("after", { settings: { instructions: "Reply OK." } }),
      output("o"),
    ],
    [
      thenWire("t", "f"),
      ...branches.map((id) => thenWire("f", id)),
      ...branches.map((id) => thenWire(id, "j")),
      thenWire("j", "after"),
      thenWire("after", "o"),
    ],
  );
  return {
    ...parsed,
    session: {
      ...parsed.session,
      model: "haiku",
      allowedTools: ["Bash"],
      permissionMode: "acceptEdits" as const,
    },
  };
}

const hookAt = (event: HookEvent) => event.payload["flowdeck_hook_at"] as number;

const describeEvent = ({ kind, payload }: HookEvent) =>
  [
    payload["flowdeck_hook_at"],
    kind,
    payload["agent_id"],
    payload["agent_type"],
    payload["tool_name"],
    kind === "PreToolUse" ? JSON.stringify(payload["tool_input"]) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

type LiveRun = {
  code: number;
  recorded: HookEvent[];
  events: StoredEvent[];
  cleanup: () => Promise<void>;
};

async function runLive(
  parsed: ReturnType<typeof parallelFlow>,
  sessionName: string,
): Promise<LiveRun> {
  const recorded: HookEvent[] = [];
  const sessionIds: string[] = [];
  const home = await mkdtemp(join(tmpdir(), "fd-home-"));
  const repo = await createTmpRepo();
  const cleanup = async () => {
    await killTmuxServer(sessionName);
    await removeClaudeSessions(repo.path, sessionIds);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  };
  const built = await build(parsed, {
    fs: new NodeFileSystem(),
    home,
    hooks: { nodePath: process.execPath, hookScriptPath },
  });
  if (!built.ok) throw new Error(`flow does not build: ${JSON.stringify(built.errors)}`);

  let server: HookSocketServer | undefined;
  const real = realDeps();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: CliDeps = {
    ...real,
    env: { ...process.env, FLOWDECK_HOME: home },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    startEvents: async (socketPath) => {
      await mkdir(dirname(socketPath), { recursive: true });
      server = new HookSocketServer({ socketPath });
      await server.start();
      const started = server;
      return { events: started, stop: () => started.stop() };
    },
    openSession: async (options) => {
      const opened = await real.openSession(options);
      sessionIds.push(opened.sessionId);
      if (server === undefined) throw new Error("hook socket not started");
      for (const kind of hookKinds) {
        server.subscribe(kind, opened.sessionId, (event) => recorded.push(event));
      }
      return opened;
    },
  };

  const code = await runCli(
    ["run", built.dir, "--cwd", repo.path, "--session", sessionName, "--model", "haiku"],
    deps,
  );

  const runId = stderr.map((line) => /^run (\S+)/.exec(line)?.[1]).find(Boolean);
  const store = new SqliteStore({ path: join(home, "flowdeck.db") });
  const events = runId === undefined ? [] : store.events(runId);
  store.close();
  console.log(
    [
      `hash: ${built.hash}`,
      `exit: ${code}`,
      `stdout:\n${stdout.join("\n")}`,
      `stderr:\n${stderr.join("\n")}`,
      `run events:\n${events.map((event) => `${event.time} ${event.nodeId} ${event.kind}`).join("\n")}`,
      `hook events in order:\n${recorded.map(describeEvent).join("\n")}`,
    ].join("\n"),
  );
  return { code, recorded, events, cleanup };
}

async function processesMatching(pattern: string): Promise<string> {
  try {
    return (await promisify(execFile)("pgrep", ["-fl", pattern])).stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return "";
    throw error;
  }
}

const timeOf = (events: readonly StoredEvent[], nodeId: string, kind: string) =>
  Date.parse(events.find((event) => event.nodeId === nodeId && event.kind === kind)?.time ?? "");

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("parallel sections with real claude", () => {
  let live: LiveRun | undefined;
  let recorded: HookEvent[] = [];
  let events: StoredEvent[] = [];

  beforeAll(async () => {
    live = await runLive(
      parallelFlow({ a1: 15, a2: 15, a3: 15, a4: 30 }, "all"),
      `fd-live-parallel-${process.pid}`,
    );
    ({ recorded, events } = live);
  }, runTimeoutMs);

  afterAll(async () => {
    await live?.cleanup();
  }, 60_000);

  it("starts the four agents within 10 s of each other", () => {
    const typeOfAgent = new Map(
      recorded
        .filter((event) => event.kind === "SubagentStop")
        .map((event) => [event.payload["agent_id"], event.payload["agent_type"]]),
    );
    const starts = new Map<unknown, number>();
    for (const event of recorded) {
      const type = typeOfAgent.get(event.payload["agent_id"]);
      if (event.kind === "PreToolUse" && type !== undefined && !starts.has(type)) {
        starts.set(type, hookAt(event));
      }
    }
    const times = [...starts.values()];
    console.log(`starts: ${JSON.stringify(Object.fromEntries(starts))}`);
    console.log(`spread: ${Math.max(...times) - Math.min(...times)} ms`);

    expect(times).toHaveLength(4);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(10_000);
  });

  it("starts the node after Join only after the last SubagentStop", () => {
    const lastSubagentStop = Math.max(
      ...recorded.filter((event) => event.kind === "SubagentStop").map(hookAt),
    );
    const afterSent = events.find((event) => event.nodeId === "after" && event.kind === "sent");
    console.log(
      `last SubagentStop: ${lastSubagentStop}, after sent: ${afterSent?.time ?? "never"}`,
    );

    expect(afterSent).toBeDefined();
    expect(Date.parse(afterSent?.time ?? "")).toBeGreaterThan(lastSubagentStop);
  });
});

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")(
  "a join that waits for first with real claude",
  () => {
    let live: LiveRun | undefined;
    let events: StoredEvent[] = [];

    beforeAll(async () => {
      live = await runLive(
        parallelFlow({ a1: 5, a2: 90 }, "first"),
        `fd-live-first-${process.pid}`,
      );
      ({ events } = live);
    }, runTimeoutMs);

    afterAll(async () => {
      await live?.cleanup();
    }, 60_000);

    it("finishes the run, starting the node after Join well before the slow branch could finish", () => {
      const elapsed = timeOf(events, "after", "sent") - timeOf(events, "f", "sent");
      console.log(`fork sent to after sent: ${elapsed} ms`);

      expect(live?.code).toBe(0);
      expect(elapsed).toBeLessThan(60_000);
    });

    it("ends the slow branch skipped", () => {
      expect(events.filter((event) => event.nodeId === "a2").at(-1)?.kind).toBe("skipped");
    });

    it("leaves no sleep of the slow branch running", async () => {
      expect(await processesMatching("sleep 90")).toBe("");
    });
  },
);
