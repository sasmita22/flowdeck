import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSocketPath } from "../fixtures/hook-socket.js";

const scriptPath = fileURLToPath(new URL("../../bin/flowdeck-mcp.ts", import.meta.url));
const session = "fd-bp-flow-1";
const replyTimeoutMs = 5000;

type Reply = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown };
};

type Answer = (line: Record<string, unknown>) => unknown;

function stubSocket(socketPath: string, answer: Answer) {
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      const line = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
      received.push(line);
      socket.end(JSON.stringify(answer(line)) + "\n");
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, listening, close };
}

class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<unknown, (reply: Reply) => void>();
  private readonly unrequested: Reply[] = [];
  private stderr = "";
  private exited: string | undefined;
  private readonly exitWaiters = new Set<(reason: string) => void>();

  constructor(socketPath: string) {
    this.child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, FLOWDECK_BP_SOCK: socketPath, FLOWDECK_BP_SESSION: session },
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
    this.child.stdout.setEncoding("utf8");
    let buffered = "";
    this.child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines.filter((text) => text.trim() !== "")) {
        const reply = JSON.parse(line) as Reply;
        const resolve = this.waiting.get(reply.id);
        if (resolve === undefined) this.unrequested.push(reply);
        else {
          this.waiting.delete(reply.id);
          resolve(reply);
        }
      }
    });
    this.child.on("exit", (code, signal) => {
      this.exited = `the script exited (code ${code}, signal ${signal}): ${this.stderr}`;
      for (const fail of this.exitWaiters) fail(this.exited);
    });
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  get repliesNobodyAskedFor(): Reply[] {
    return this.unrequested;
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(id: number, method: string, params: unknown = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.exited !== undefined) return reject(new Error(this.exited));
      const fail = (reason: string) => reject(new Error(reason));
      const timer = setTimeout(
        () =>
          reject(new Error(`no reply to ${method} within ${replyTimeoutMs} ms: ${this.stderr}`)),
        replyTimeoutMs,
      );
      this.exitWaiters.add(fail);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        this.exitWaiters.delete(fail);
        resolve(reply);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  stop(): void {
    this.child.kill();
  }
}

const textOf = (reply: Reply): string => {
  const content = reply.result?.["content"] as { type: string; text: string }[] | undefined;
  expect(content?.[0]?.type).toBe("text");
  return content?.[0]?.text ?? "";
};

describe("flowdeck-mcp", () => {
  let dir: string;
  let socketPath: string;
  let client: McpClient | undefined;
  let stub: ReturnType<typeof stubSocket> | undefined;

  beforeEach(async () => {
    ({ dir, socketPath } = await makeSocketPath());
  });

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await stub?.close();
    stub = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const start = async (answer: Answer) => {
    stub = stubSocket(socketPath, answer);
    await stub.listening;
    client = new McpClient(socketPath);
    return { client, stub };
  };

  it("answers initialize with the client's protocol version, a tools capability and its name", async () => {
    const { client } = await start(() => ({}));

    const reply = await client.request(1, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "0" },
    });

    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.result).toMatchObject({
      protocolVersion: "2099-01-01",
      capabilities: { tools: expect.any(Object) },
      serverInfo: { name: "flowdeck" },
    });
  });

  it("sends no reply to notifications/initialized", async () => {
    const { client } = await start(() => ({}));

    client.notify("notifications/initialized");
    await client.request(2, "tools/list");

    expect(client.repliesNobodyAskedFor).toEqual([]);
  });

  it("lists the tools the socket gives for this session", async () => {
    const tools = [
      { name: "read_blueprint", description: "Read it.", inputSchema: { type: "object" } },
    ];
    const { client, stub } = await start((line) => (line["type"] === "tools" ? tools : {}));

    const reply = await client.request(3, "tools/list");

    expect(stub.received).toEqual([{ type: "tools", session }]);
    expect(reply.result?.["tools"]).toEqual(tools);
  });

  it("answers ping with an empty result", async () => {
    const { client } = await start(() => ({}));

    const reply = await client.request(9, "ping");

    expect(reply).toMatchObject({ id: 9, result: {} });
    expect(reply.error).toBeUndefined();
  });

  it("answers a refused tool list with JSON-RPC error -32603 carrying the reason", async () => {
    const { client } = await start(() => ({ ok: false, reason: "x-refused" }));

    const reply = await client.request(10, "tools/list");

    expect(reply.error?.code).toBe(-32603);
    expect(reply.error?.message).toContain("x-refused");
    expect(reply.result).toBeUndefined();
  });

  it("relays a tool call to the socket and answers an ok result as text", async () => {
    const { client, stub } = await start(() => ({ ok: true, nodeId: "agent-7" }));

    const reply = await client.request(4, "tools/call", {
      name: "add_node",
      arguments: { type: "agent", label: "Plan" },
    });

    expect(stub.received).toEqual([
      { type: "call", session, name: "add_node", input: { type: "agent", label: "Plan" } },
    ]);
    expect(reply.result?.["isError"]).not.toBe(true);
    expect(textOf(reply)).toContain("agent-7");
  });

  it("answers a refused result as an error carrying its reason", async () => {
    const { client } = await start(() => ({ ok: false, reason: "no node named zz9" }));

    const reply = await client.request(5, "tools/call", {
      name: "delete_node",
      arguments: { nodeId: "zz9" },
    });

    expect(reply.result?.["isError"]).toBe(true);
    expect(textOf(reply)).toContain("no node named zz9");
  });

  it("answers a call as an error when the socket is gone, and keeps running", async () => {
    client = new McpClient(join(dir, "missing.sock"));

    const reply = await client.request(6, "tools/call", {
      name: "read_blueprint",
      arguments: {},
    });

    expect(reply.result?.["isError"]).toBe(true);
    expect(textOf(reply)).toMatch(/\S/);
    const next = await client.request(7, "initialize", { protocolVersion: "2099-01-01" });
    expect(next.result?.["protocolVersion"]).toBe("2099-01-01");
    expect(client.running).toBe(true);
  });

  it("answers an unknown method with JSON-RPC error -32601", async () => {
    const { client } = await start(() => ({}));

    const reply = await client.request(8, "resources/list");

    expect(reply.error?.code).toBe(-32601);
  });

  it("imports only node builtins", () => {
    const source = readFileSync(scriptPath, "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier?.startsWith("node:"))).toEqual([]);
  });
});
