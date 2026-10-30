import { lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { EventBus } from "../../core/event-bus.js";
import { denied } from "../../core/run/permission.js";
import type { EventSource, HookEvent, HookEventKind } from "../../ports/event-source.js";
import type { PermissionDecision, PermissionSource } from "../../ports/permission-source.js";

const maxLineLength = 10 * 1024 * 1024;

const hookEventKinds: Record<HookEventKind, true> = {
  Stop: true,
  PreToolUse: true,
  PostToolUse: true,
  SubagentStop: true,
};

function isHookEventKind(value: unknown): value is HookEventKind {
  return typeof value === "string" && Object.hasOwn(hookEventKinds, value);
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string);
}

function reportToStderr(reason: string, line: string): void {
  process.stderr.write(`Rejected hook event (${reason}): ${line}\n`);
}

type PermissionHandler = (
  payload: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<PermissionDecision>;

const permissionRequest = "PermissionRequest";

export class HookSocketServer implements EventSource, PermissionSource {
  private readonly socketPath: string;
  private readonly onRejected: (reason: string, line: string) => void;
  private readonly bus = new EventBus<HookEvent>();
  private readonly connections = new Set<Socket>();
  private readonly permissionHandlers = new Map<string, PermissionHandler>();
  private readonly server: Server = createServer((socket) => this.accept(socket));

  constructor(options: {
    socketPath: string;
    onRejected?: (reason: string, line: string) => void;
  }) {
    this.socketPath = options.socketPath;
    this.onRejected = options.onRejected ?? reportToStderr;
  }

  async start(): Promise<void> {
    await this.removeStaleSocket();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  subscribe(
    kind: HookEventKind,
    sessionId: string,
    handler: (event: HookEvent) => void,
  ): () => void {
    return this.bus.subscribe(kind, sessionId, handler);
  }

  onRequest(sessionId: string, handler: PermissionHandler): () => void {
    this.permissionHandlers.set(sessionId, handler);
    return () => {
      if (this.permissionHandlers.get(sessionId) === handler) {
        this.permissionHandlers.delete(sessionId);
      }
    };
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      if (!(await lstat(this.socketPath)).isSocket()) {
        throw new Error(`"${this.socketPath}" exists and is not a socket`);
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (await this.isLive()) throw new Error(`Another server is listening on "${this.socketPath}"`);
    await unlink(this.socketPath);
  }

  private isLive(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const probe = connect(this.socketPath);
      probe.on("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.on("error", (error) =>
        hasCode(error, "ECONNREFUSED") ? resolve(false) : reject(error),
      );
    });
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", (error) => {
      if (!hasCode(error, "ECONNRESET", "EPIPE")) throw error;
    });
    socket.setEncoding("utf8");
    let remainder = "";
    socket.on("data", (chunk: string) => {
      remainder += chunk;
      if (chunk.includes("\n")) {
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > maxLineLength) {
            this.onRejected(`line longer than ${maxLineLength} characters`, line);
          } else {
            this.handle(line, socket);
          }
        }
      }
      if (remainder.length > maxLineLength) {
        this.onRejected(`line longer than ${maxLineLength} characters`, remainder);
        remainder = "";
        socket.destroy();
      }
    });
    socket.on("end", () => {
      if (remainder.length > 0) this.onRejected("trailing fragment without a newline", remainder);
    });
  }

  private handle(line: string, socket: Socket): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.onRejected("not JSON", line);
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.onRejected("not a JSON object", line);
      return;
    }
    const payload = value as Record<string, unknown>;
    const kind = payload["hook_event_name"];
    const sessionId = payload["session_id"];
    if (kind === permissionRequest) {
      void this.answer(socket, payload, sessionId);
      return;
    }
    if (!isHookEventKind(kind)) {
      this.onRejected("unknown hook_event_name", line);
      return;
    }
    if (typeof sessionId !== "string" || sessionId === "") {
      this.onRejected("missing session_id", line);
      return;
    }
    this.bus.publish({ kind, sessionId, payload });
  }

  private async answer(
    socket: Socket,
    payload: Record<string, unknown>,
    sessionId: unknown,
  ): Promise<void> {
    const handler =
      typeof sessionId === "string" ? this.permissionHandlers.get(sessionId) : undefined;
    const closed = new AbortController();
    socket.once("close", () => closed.abort());
    let decision: PermissionDecision;
    try {
      decision =
        handler === undefined
          ? denied("No run is listening")
          : await handler(payload, closed.signal);
    } catch (error) {
      decision = denied(error instanceof Error ? error.message : String(error));
    }
    if (socket.destroyed || socket.writableEnded) return;
    socket.end(JSON.stringify(decision) + "\n");
  }
}
