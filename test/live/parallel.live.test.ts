import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import type { RunStatus, StoredEvent } from "../../src/core/run/store.js";
import type { HookEvent } from "../../src/ports/event-source.js";
import {
  agent,
  flow,
  fork,
  join as joinNode,
  output,
  thenWire,
  trigger,
} from "../fixtures/flow-builders.js";
import { liveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo } from "../fixtures/tmp-repo.js";

const buildName = "live-parallel";
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
      agent("after", { settings: { instructions: "Reply OK." } }),
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
  status: RunStatus | undefined;
  recorded: HookEvent[];
  events: StoredEvent[];
  cleanup: () => Promise<void>;
};

async function runLive(
  parsed: ReturnType<typeof parallelFlow>,
  sessionName: string,
): Promise<LiveRun> {
  const recorded: HookEvent[] = [];
  const home = await mkdtemp(join(tmpdir(), "fd-home-"));
  const repo = await createTmpRepo({ commit: true });
  let server: HookSocketServer | undefined;
  const engine = liveEngine({
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
      for (const kind of hookKinds) {
        server.subscribe(kind, opened.sessionId, (event) => recorded.push(event));
      }
      return opened;
    },
  });
  const cleanup = async () => {
    await engine.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  };

  try {
    const built = await engine.saveAndBuild(parsed, { name: buildName });
    const runId = await engine.runBuild(built.buildId);
    let status: RunStatus | undefined;
    try {
      status = await engine.waitForRunEnd(runId, runTimeoutMs - 60_000);
    } finally {
      console.log(
        [
          `hash: ${built.hash}`,
          `status: ${status ?? "still running"}`,
          `run events:\n${engine.stores.runs
            .events(runId)
            .map((event) => `${event.time} ${event.nodeId} ${event.kind}`)
            .join("\n")}`,
          `hook events in order:\n${recorded.map(describeEvent).join("\n")}`,
        ].join("\n"),
      );
    }
    const events = engine.stores.runs.events(runId);
    return { status, recorded, events, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
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

      expect(live?.status).toBe("done");
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
