import { once } from "node:events";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookSocketServer } from "../../../src/adapters/hook-socket/hook-socket-server.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import {
  hasCode,
  makeSocketPath,
  makeStaleSocket,
  runHook,
  waitUntil,
} from "../../fixtures/hook-socket.js";

const fixtures = ["stop", "pre-tool-use", "post-tool-use", "subagent-stop"] as const;
const kinds: HookEventKind[] = ["Stop", "PreToolUse", "PostToolUse", "SubagentStop"];
const readFixture = (name: string) =>
  readFile(new URL(`../../fixtures/hooks/${name}.json`, import.meta.url), "utf8");
const parseFixture = async (name: string) =>
  JSON.parse(await readFixture(name)) as Record<string, unknown> & { session_id: string };

function sendRaw(socketPath: string, data: string | Buffer, end = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    client.on("error", (error) => {
      if (!hasCode(error, "EPIPE", "ECONNRESET")) reject(error);
    });
    client.on("close", () => resolve());
    client.write(data);
    if (end) client.end();
  });
}

describe("HookSocketServer", () => {
  let dir: string;
  let socketPath: string;
  let rejected: ReturnType<typeof vi.fn<(reason: string, line: string) => void>>;
  let running: HookSocketServer[];
  let stop: Record<string, unknown> & { session_id: string };

  beforeEach(async () => {
    ({ dir, socketPath } = await makeSocketPath());
    rejected = vi.fn<(reason: string, line: string) => void>();
    running = [];
    stop = await parseFixture("stop");
  });

  afterEach(async () => {
    for (const server of running) await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function startServer(
    options: { onRejected?: (reason: string, line: string) => void } = { onRejected: rejected },
  ): Promise<HookSocketServer> {
    const server = new HookSocketServer({ socketPath, ...options });
    await server.start();
    running.push(server);
    return server;
  }

  function collect(server: HookSocketServer, kind: HookEventKind, sessionId: string): HookEvent[] {
    const events: HookEvent[] = [];
    server.subscribe(kind, sessionId, (event) => events.push(event));
    return events;
  }

  async function expectBarrier(server: HookSocketServer): Promise<void> {
    const barrier = collect(server, "Stop", "barrier");
    await sendRaw(socketPath, JSON.stringify({ ...stop, session_id: "barrier" }) + "\n");
    await waitUntil(
      () => barrier.length === 1,
      2000,
      () => `expected the barrier event, got ${barrier.length}`,
    );
  }

  it("emits exactly one Stop event for the Stop sample", async () => {
    const server = await startServer();
    const preToolUse = await parseFixture("pre-tool-use");
    const stops = collect(server, "Stop", stop.session_id);
    const preToolUses = collect(server, "PreToolUse", preToolUse.session_id);

    expect((await runHook({ socketPath, stdin: await readFixture("stop") })).code).toBe(0);
    await waitUntil(
      () => stops.length >= 1,
      2000,
      () => `expected 1 Stop event, got ${stops.length}`,
    );
    expect((await runHook({ socketPath, stdin: await readFixture("pre-tool-use") })).code).toBe(0);
    await waitUntil(
      () => preToolUses.length >= 1,
      2000,
      () => `expected 1 PreToolUse event, got ${preToolUses.length}`,
    );

    expect(stops).toHaveLength(1);
    expect(stops[0]?.sessionId).toBe(stop.session_id);
    expect(stops[0]?.payload).toEqual({ ...stop, flowdeck_hook_at: expect.any(Number) });
    expect(rejected).not.toHaveBeenCalled();
  });

  it.each(fixtures)("emits the %s sample as an event of its kind and session", async (name) => {
    const server = await startServer();
    const sample = await parseFixture(name);
    const events = collect(server, sample["hook_event_name"] as HookEventKind, sample.session_id);

    await runHook({ socketPath, stdin: await readFixture(name) });
    await waitUntil(
      () => events.length >= 1,
      2000,
      () => `expected 1 ${name} event, got ${events.length}`,
    );

    expect(events).toEqual([
      {
        kind: sample["hook_event_name"],
        sessionId: sample.session_id,
        payload: { ...sample, flowdeck_hook_at: expect.any(Number) },
      },
    ]);
  });

  it("emits 50 events for 50 hooks run at once, none merged or lost", async () => {
    const server = await startServer();
    const sent = new Map<string, Record<string, unknown>>();
    const events: HookEvent[] = [];
    for (let i = 0; i < 50; i++) {
      const sessionId = `s-${i}`;
      const payload: Record<string, unknown> = { ...stop, session_id: sessionId };
      if (i % 2 === 0) payload["last_assistant_message"] = "y".repeat(200 * 1024);
      sent.set(sessionId, payload);
      server.subscribe("Stop", sessionId, (event) => events.push(event));
    }

    const runs = await Promise.all(
      [...sent.values()].map((payload) => runHook({ socketPath, stdin: JSON.stringify(payload) })),
    );
    await waitUntil(
      () => events.length >= 50,
      5000,
      () => `expected 50 events, got ${events.length}`,
    );

    expect(runs.every((run) => run.code === 0)).toBe(true);
    expect(events).toHaveLength(50);
    expect(new Set(events.map((event) => event.sessionId)).size).toBe(50);
    for (const event of events) {
      expect(event.payload).toEqual({
        ...sent.get(event.sessionId),
        flowdeck_hook_at: expect.any(Number),
      });
    }
    expect(rejected).not.toHaveBeenCalled();
  }, 10_000);

  it("rejects invalid JSON once and keeps running", async () => {
    const server = await startServer();
    const stops = collect(server, "Stop", stop.session_id);

    expect((await runHook({ socketPath, stdin: "not json {" })).code).toBe(0);
    await waitUntil(
      () => rejected.mock.calls.length >= 1,
      2000,
      () => "expected the invalid line to be rejected",
    );
    await runHook({ socketPath, stdin: await readFixture("stop") });
    await waitUntil(
      () => stops.length >= 1,
      2000,
      () => `expected 1 Stop event after the rejection, got ${stops.length}`,
    );

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[1]).toBe("not json {");
  });

  it("rejects a trailing fragment with no newline and keeps running", async () => {
    const server = await startServer();
    const stops = collect(server, "Stop", stop.session_id);

    await sendRaw(socketPath, JSON.stringify(stop));
    await expectBarrier(server);

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[1]).toBe(JSON.stringify(stop));
    expect(stops).toEqual([]);
  });

  it.each([
    ["an array", "[1]"],
    ["a string", '"text"'],
    ["null", "null"],
    ["an unknown kind", '{"hook_event_name":"UserPromptSubmit","session_id":"x"}'],
    ["a missing session_id", '{"hook_event_name":"Stop"}'],
    ["an empty session_id", '{"hook_event_name":"Stop","session_id":""}'],
    ["a numeric session_id", '{"hook_event_name":"Stop","session_id":5}'],
  ])("rejects %s once and keeps running", async (_name, line) => {
    const server = await startServer();
    const seen: HookEvent[] = [];
    for (const kind of kinds) {
      server.subscribe(kind, "x", (event) => seen.push(event));
      server.subscribe(kind, "", (event) => seen.push(event));
    }

    await sendRaw(socketPath, line + "\n");
    await expectBarrier(server);

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected.mock.calls[0]?.[1]).toBe(line);
    expect(seen).toEqual([]);
  });

  it("rejects a line over 10 MB and closes that connection", async () => {
    await startServer();

    await sendRaw(socketPath, Buffer.alloc(10 * 1024 * 1024 + 1, "a"), false);

    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("rejects a complete line just over 10 MB that arrives with its newline", async () => {
    const server = await startServer();
    const stop = await parseFixture("stop");
    const base = JSON.stringify({ ...stop, padding: "" });
    const line = JSON.stringify({
      ...stop,
      padding: "a".repeat(10 * 1024 * 1024 + 10 - base.length),
    });
    const seen: HookEvent[] = [];
    server.subscribe("Stop", stop.session_id, (event) => seen.push(event));

    await sendRaw(socketPath, line + "\n");
    await expectBarrier(server);

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("reports a rejected line on stderr when no reporter is given", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const server = await startServer({});

      await sendRaw(socketPath, "not json {\n");
      await expectBarrier(server);

      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain("not json {");
      expect(String(stderr.mock.calls[0]?.[0]).endsWith("\n")).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("replaces a stale socket file on start", async () => {
    await makeStaleSocket(socketPath);

    const server = await startServer();
    const stops = collect(server, "Stop", stop.session_id);
    await runHook({ socketPath, stdin: await readFixture("stop") });

    await waitUntil(
      () => stops.length === 1,
      2000,
      () => `expected 1 Stop event, got ${stops.length}`,
    );
  });

  it("refuses to start over a live server, which keeps running", async () => {
    const first = await startServer();
    const stops = collect(first, "Stop", stop.session_id);

    await expect(
      new HookSocketServer({ socketPath, onRejected: rejected }).start(),
    ).rejects.toThrow(`Another server is listening on "${socketPath}"`);
    await runHook({ socketPath, stdin: await readFixture("stop") });

    await waitUntil(
      () => stops.length === 1,
      2000,
      () => `expected 1 Stop event, got ${stops.length}`,
    );
  });

  it("refuses to start over a file that is not a socket, and leaves it alone", async () => {
    await writeFile(socketPath, "keep me");

    await expect(
      new HookSocketServer({ socketPath, onRejected: rejected }).start(),
    ).rejects.toThrow(`"${socketPath}" exists and is not a socket`);

    expect(await readFile(socketPath, "utf8")).toBe("keep me");
  });

  it("stops with a connection still open and removes the socket file", async () => {
    const server = new HookSocketServer({ socketPath, onRejected: rejected });
    await server.start();
    const client: Socket = connect(socketPath);
    await once(client, "connect");
    client.on("error", (error) => {
      if (!hasCode(error, "ECONNRESET")) throw error;
    });

    const stopped = await Promise.race([
      server.stop().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    client.destroy();

    expect(stopped).toBe(true);
    await expect(lstat(socketPath)).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});
