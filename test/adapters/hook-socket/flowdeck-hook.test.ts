import { readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HookRun,
  makeSocketPath,
  makeStaleSocket,
  runHook,
  waitUntil,
} from "../../fixtures/hook-socket.js";

const fixtures = ["stop", "pre-tool-use", "post-tool-use", "subagent-stop"] as const;
const readFixture = (name: string) =>
  readFile(new URL(`../../fixtures/hooks/${name}.json`, import.meta.url), "utf8");

type Collector = { connections: string[]; close: () => Promise<void> };

function listen(socketPath: string, options: { neverRead?: boolean } = {}): Promise<Collector> {
  const connections: string[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    if (options.neverRead) {
      socket.pause();
      return;
    }
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => connections.push(data));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () =>
      resolve({
        connections,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

function expectQuiet(run: HookRun): void {
  expect(run.code).toBe(0);
  expect(run.stdout).toBe("");
}

describe("flowdeck-hook", () => {
  let dir: string;
  let socketPath: string;
  let collector: Collector | undefined;

  beforeEach(async () => {
    ({ dir, socketPath } = await makeSocketPath());
  });

  afterEach(async () => {
    await collector?.close();
    collector = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function sendAndWait(stdin: string): Promise<Collector> {
    const listening = await listen(socketPath);
    collector = listening;
    expectQuiet(await runHook({ socketPath, stdin }));
    await waitUntil(
      () => listening.connections.length >= 1,
      2000,
      () => `expected 1 connection, got ${listening.connections.length}`,
    );
    return listening;
  }

  it.each(fixtures)("forwards the multi-line %s sample as one compact line", async (name) => {
    const fixture = await readFixture(name);
    expect(fixture.trim().split("\n").length).toBeGreaterThan(1);

    const { connections } = await sendAndWait(fixture);

    expect(connections).toEqual([JSON.stringify(JSON.parse(fixture)) + "\n"]);
  });

  it("does not add a hook_event_name the input lacks", async () => {
    const { connections } = await sendAndWait('{"session_id":"x"}');

    expect(connections).toEqual(['{"session_id":"x"}\n']);
  });

  it("keeps the sample's own hook_event_name", async () => {
    const { connections } = await sendAndWait(await readFixture("pre-tool-use"));

    expect(JSON.parse(connections[0] ?? "")).toHaveProperty("hook_event_name", "PreToolUse");
  });

  it("forwards invalid JSON as one line with its line breaks replaced by spaces", async () => {
    const { connections } = await sendAndWait("not json {\r\nsecond line");

    expect(connections).toEqual(["not json {  second line\n"]);
  });

  it("exits 0 quietly on JSON nested too deeply to re-serialise", async () => {
    const deep = "[".repeat(200_000) + "]".repeat(200_000);

    expectQuiet(await runHook({ socketPath, stdin: deep }));
  });

  it.each([
    { name: "stdin is empty", stdin: "", env: {} },
    { name: "FLOWDECK_SOCK is unset", stdin: "{}", env: {}, unset: true },
    { name: "FLOWDECK_SOCK is empty", stdin: "{}", env: { FLOWDECK_SOCK: "" } },
  ])("writes nothing when $name", async ({ stdin, env, unset }) => {
    const listening = await listen(socketPath);
    collector = listening;

    expectQuiet(await runHook({ ...(unset ? {} : { socketPath }), stdin, env }));
    expectQuiet(await runHook({ socketPath, stdin: await readFixture("stop") }));
    await waitUntil(
      () => listening.connections.length >= 1,
      2000,
      () => `expected the barrier connection, got ${listening.connections.length}`,
    );

    expect(listening.connections).toHaveLength(1);
    expect(listening.connections[0]).toContain('"hook_event_name":"Stop"');
  });

  it("exits 0 having sent nothing when stdin is never closed", async () => {
    const listening = await listen(socketPath);
    collector = listening;
    const stdin = await readFixture("stop");

    const run = await Promise.race([
      runHook({ socketPath, stdin, keepStdinOpen: true }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
    ]);
    expect(run, "the hook was still running after 3 s").toBeDefined();
    expectQuiet(run as HookRun);
    expect(run?.ms).toBeLessThan(2200);
    expectQuiet(await runHook({ socketPath, stdin }));
    await waitUntil(
      () => listening.connections.length >= 1,
      2000,
      () => `expected the barrier connection, got ${listening.connections.length}`,
    );

    expect(listening.connections).toHaveLength(1);
  });

  it("exits 0 in under 200 ms when there is no socket file", async () => {
    const run = await runHook({ socketPath, stdin: await readFixture("stop") });

    expectQuiet(run);
    expect(run.ms).toBeLessThan(200);
  });

  it("exits 0 in under 200 ms when the socket file is stale", async () => {
    await makeStaleSocket(socketPath);

    const run = await runHook({ socketPath, stdin: await readFixture("stop") });

    expectQuiet(run);
    expect(run.ms).toBeLessThan(200);
  });

  it("exits 0 within 1500 ms when the server accepts but never reads", async () => {
    collector = await listen(socketPath, { neverRead: true });
    const sample = JSON.parse(await readFixture("stop")) as Record<string, unknown>;
    sample["last_assistant_message"] = "x".repeat(2 * 1024 * 1024);

    const run = await runHook({ socketPath, stdin: JSON.stringify(sample) });

    expectQuiet(run);
    expect(run.ms).toBeLessThan(1500);
  });
});
