import { connect } from "node:net";

type Id = string | number | null;

type Request = { id?: Id; method?: unknown; params?: unknown };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const methodNotFound = -32601;
const internalError = -32603;

const socketPath = process.env["FLOWDECK_BP_SOCK"] ?? "";
const session = process.env["FLOWDECK_BP_SESSION"] ?? "";

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function ask(line: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!socketPath) return reject(new Error("FLOWDECK_BP_SOCK is not set"));
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let reply = "";
    socket.on("error", (error) =>
      reject(new Error(`Flowdeck could not be reached: ${error.message}`)),
    );
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => {
      const end = reply.indexOf("\n");
      if (end === -1) return reject(new Error("Flowdeck closed the connection without an answer"));
      try {
        resolve(JSON.parse(reply.slice(0, end)));
      } catch {
        reject(new Error(`Flowdeck sent an unreadable reply: ${reply.slice(0, end)}`));
      }
    });
    socket.write(JSON.stringify({ ...line, session }) + "\n");
  });
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: string, isError: boolean): ToolResult =>
  isError
    ? { content: [{ type: "text", text: value }], isError: true }
    : { content: [{ type: "text", text: value }] };

async function callTool(params: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result = record(
      await ask({ type: "call", name: params["name"], input: params["arguments"] ?? {} }),
    );
    if (result["ok"] === false)
      return text(String(result["reason"] ?? "Flowdeck refused the call"), true);
    return text(JSON.stringify(result), false);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

async function listTools(): Promise<unknown[]> {
  const tools = await ask({ type: "tools" });
  if (Array.isArray(tools)) return tools;
  throw new Error(String(record(tools)["reason"] ?? "Flowdeck sent no tool list"));
}

async function handle(request: Request): Promise<void> {
  const params = record(request.params);
  if (request.id === undefined) return;
  const id = request.id;
  try {
    switch (request.method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: "flowdeck", version: "1" },
          },
        });
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({ id, result: { tools: await listTools() } });
      case "tools/call":
        return send({ id, result: await callTool(params) });
      default:
        return send({
          id,
          error: { code: methodNotFound, message: `Method not found: ${String(request.method)}` },
        });
    }
  } catch (error) {
    send({
      id,
      error: {
        code: internalError,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function parse(line: string): Request | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Request)
      : undefined;
  } catch {
    return undefined;
  }
}

process.stdin.setEncoding("utf8");
let buffered = "";
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    const request = parse(line);
    if (request !== undefined) void handle(request);
  }
});
process.stdin.on("end", () => process.exit(0));
