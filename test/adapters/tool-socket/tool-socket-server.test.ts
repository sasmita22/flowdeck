import { readFile, lstat, rm } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolSocketServer } from "../../../src/adapters/tool-socket/tool-socket-server.js";
import type { ToolSocketMessage } from "../../../src/ports/tool-socket.js";
import {
  hasCode,
  makeSocketPath,
  makeStaleSocket,
  runHook,
  waitUntil,
} from "../../fixtures/hook-socket.js";

const session = "fd-bp-flow-1";
const toolsLine = { type: "tools", session };
const callLine = { type: "call", session, name: "delete_node", input: { nodeId: "a1" } };

const readStopFixture = () =>
  readFile(new URL("../../fixtures/hooks/stop.json", import.meta.url), "utf8");

function exchange(socketPath: string, data: string, end: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = "";
    const client = connect(socketPath);
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => (reply += chunk));
    client.on("error", (error) => {
      if (!hasCode(error, "EPIPE", "ECONNRESET")) reject(error);
    });
    client.on("close", () => resolve(reply));
    client.write(data);
    if (end) client.end();
  });
}

const ask = (socketPath: string, line: unknown) =>
  exchange(socketPath, JSON.stringify(line) + "\n", false);

describe("ToolSocketServer", () => {
  let dir: string;
  let socketPath: string;
  let server: ToolSocketServer;
  let seen: ToolSocketMessage[];

  beforeEach(async () => {
    ({ dir, socketPath } = await makeSocketPath());
    server = new ToolSocketServer();
    seen = [];
  });

  afterEach(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function listen(reply: (message: ToolSocketMessage) => unknown = () => ({ ok: true })) {
    await server.listen(socketPath, async (message) => {
      seen.push(message);
      return reply(message);
    });
  }

  it("hands a tools line to the handler and sends its reply back as one JSON line", async () => {
    const definitions = [{ name: "list_blueprints", description: "List", inputSchema: {} }];
    await listen(() => definitions);

    const reply = await ask(socketPath, toolsLine);

    expect(seen).toEqual([{ kind: "tools", session }]);
    expect(reply).toBe(JSON.stringify(definitions) + "\n");
  });

  it("hands a call line to the handler and sends its reply back as one JSON line", async () => {
    const result = { ok: true, problems: [] };
    await listen(() => result);

    const reply = await ask(socketPath, callLine);

    expect(seen).toEqual([{ kind: "call", session, name: "delete_node", input: { nodeId: "a1" } }]);
    expect(reply).toBe(JSON.stringify(result) + "\n");
  });

  it("answers concurrent connections each with its own reply", async () => {
    await listen((message) => (message.kind === "call" ? { ok: true, for: "call" } : ["tools"]));

    const [toolsReply, callReply] = await Promise.all([
      ask(socketPath, toolsLine),
      ask(socketPath, callLine),
    ]);

    expect(JSON.parse(toolsReply)).toEqual(["tools"]);
    expect(JSON.parse(callReply)).toEqual({ ok: true, for: "call" });
  });

  it("hands the Stop line the hook script sends to the handler as a stop", async () => {
    await listen();

    const run = await runHook({ socketPath, stdin: await readStopFixture() });
    await waitUntil(
      () => seen.length >= 1,
      2000,
      () => `expected the Stop line to reach the handler, got ${seen.length} messages`,
    );

    expect(run.code).toBe(0);
    expect(seen).toEqual([{ kind: "stop" }]);
  });

  it("writes nothing back for a Stop line, as the hook socket does", async () => {
    await listen(() => ({ ok: true }));
    const stopLine = { ...JSON.parse(await readStopFixture()), flowdeck_hook_at: 1 };

    const reply = await exchange(socketPath, JSON.stringify(stopLine) + "\n", true);
    await waitUntil(
      () => seen.length >= 1,
      2000,
      () => "expected the Stop line to reach the handler",
    );

    expect(reply).toBe("");
    expect(seen).toEqual([{ kind: "stop" }]);
  });

  it.each([
    ["not JSON", "not json {"],
    ["a JSON array", "[1]"],
    ["an unknown type", JSON.stringify({ type: "build", session })],
    ["a tools line without a session", JSON.stringify({ type: "tools" })],
    ["a call line without a name", JSON.stringify({ type: "call", session, input: {} })],
  ])("answers %s with an error line and keeps serving", async (_name, line) => {
    await listen(() => ["tools"]);

    const reply = await exchange(socketPath, line + "\n", false);

    expect(reply.endsWith("\n")).toBe(true);
    expect(reply.indexOf("\n")).toBe(reply.length - 1);
    expect(JSON.parse(reply)).toEqual({ ok: false, reason: expect.any(String) });
    expect((JSON.parse(reply) as { reason: string }).reason).not.toBe("");
    expect(seen).toEqual([]);

    expect(await ask(socketPath, toolsLine)).toBe(JSON.stringify(["tools"]) + "\n");
    expect(seen).toEqual([{ kind: "tools", session }]);
  });

  it("removes a stale socket file on listen and serves on its path", async () => {
    await makeStaleSocket(socketPath);
    await listen(() => ["tools"]);

    expect(await ask(socketPath, toolsLine)).toBe(JSON.stringify(["tools"]) + "\n");
  });

  it("removes the socket file on close", async () => {
    await listen();
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    await server.close();

    await expect(lstat(socketPath)).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});
