import type { EngineRequest, EngineResponse } from "../engine/protocol.js";

export type EnginePort = {
  postMessage(message: EngineRequest): void;
  onMessage(listener: (response: EngineResponse) => void): void;
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
  private nextId = 1;
  private exited = false;

  constructor(options: EngineClientOptions) {
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
    this.port.onMessage((response) => this.settle(response));
    this.port.onExit(() => {
      this.exited = true;
      this.rejectAll(new Error("engine exited"));
    });
  }

  request(type: EngineRequest["type"]): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("engine exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`engine did not answer ${type} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ id, type });
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
