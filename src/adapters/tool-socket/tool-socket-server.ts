import { createServer, type Server, type Socket } from "node:net";
import { socketLineSchema } from "../../core/flow/blueprint-tools.js";
import type { ToolSocket, ToolSocketHandler, ToolSocketMessage } from "../../ports/tool-socket.js";
import { hasCode, removeStaleSocket } from "../unix-socket/stale-socket.js";

const maxLineLength = 10 * 1024 * 1024;

type Parsed = { message: ToolSocketMessage } | { refused: string };

function parse(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { refused: "not JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { refused: "not a JSON object" };
  }
  if ((value as Record<string, unknown>)["hook_event_name"] === "Stop") {
    return { message: { kind: "stop" } };
  }
  const result = socketLineSchema.safeParse(value);
  if (!result.success) return { refused: result.error.message };
  const line = result.data;
  return {
    message:
      line.type === "tools"
        ? { kind: "tools", session: line.session }
        : { kind: "call", session: line.session, name: line.name, input: line.input },
  };
}

export class ToolSocketServer implements ToolSocket {
  private server: Server | undefined;
  private readonly connections = new Set<Socket>();

  async listen(path: string, handler: ToolSocketHandler): Promise<void> {
    await removeStaleSocket(path);
    const server = createServer((socket) => this.accept(socket, handler));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server === undefined || !server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private accept(socket: Socket, handler: ToolSocketHandler): void {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", (error) => {
      if (!hasCode(error, "ECONNRESET", "EPIPE")) throw error;
    });
    socket.setEncoding("utf8");
    let remainder = "";
    socket.on("data", (chunk: string) => {
      remainder += chunk;
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) void this.answer(line, socket, handler);
      if (remainder.length > maxLineLength) {
        remainder = "";
        reply(socket, { ok: false, reason: `line longer than ${maxLineLength} characters` });
      }
    });
  }

  private async answer(line: string, socket: Socket, handler: ToolSocketHandler): Promise<void> {
    const parsed = parse(line);
    if ("refused" in parsed) {
      reply(socket, { ok: false, reason: parsed.refused });
      return;
    }
    let result: unknown;
    try {
      result = await handler(parsed.message);
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (parsed.message.kind === "stop") return;
    reply(socket, result);
  }
}

function reply(socket: Socket, value: unknown): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(JSON.stringify(value) + "\n");
}
