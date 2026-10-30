import type {
  EngineMessage,
  EnginePush,
  EngineRequest,
  EngineResponse,
} from "../engine/protocol.js";

export type EnginePort = {
  postMessage(message: EngineRequest): void;
  onMessage(listener: (message: EngineMessage) => void): void;
  onExit(listener: () => void): void;
};

export type EngineClientOptions = { port: EnginePort; timeoutMs: number };

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class EngineClient {
  private readonly port: EnginePort;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly pushListeners = new Set<(push: EnginePush) => void>();
  private nextId = 1;
  private exited = false;

  constructor(options: EngineClientOptions) {
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
    this.port.onMessage((message) => {
      if ("push" in message) {
        for (const listener of [...this.pushListeners]) listener(message);
      } else {
        this.settle(message);
      }
    });
    this.port.onExit(() => {
      this.exited = true;
      this.rejectAll(new Error("engine exited"));
    });
  }

  onPush(listener: (push: EnginePush) => void): () => void {
    const wrapped = (push: EnginePush) => listener(push);
    this.pushListeners.add(wrapped);
    return () => {
      this.pushListeners.delete(wrapped);
    };
  }

  request(type: EngineRequest["type"], payload?: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("engine exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`engine did not answer ${type} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage(payload === undefined ? { id, type } : { id, type, payload });
    });
  }

  private settle(response: EngineResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
