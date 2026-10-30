import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage, EnginePush, EngineRequest } from "../../../src/app/engine/protocol.js";
import { EngineClient, type EnginePort } from "../../../src/app/main/engine-client.js";

class FakeEnginePort implements EnginePort {
  readonly posted: EngineRequest[] = [];
  private messageListener: (message: EngineMessage) => void = () => undefined;
  private exitListener: () => void = () => undefined;

  postMessage(message: EngineRequest): void {
    this.posted.push(message);
  }

  onMessage(listener: (message: EngineMessage) => void): void {
    this.messageListener = listener;
  }

  onExit(listener: () => void): void {
    this.exitListener = listener;
  }

  postedId(index: number): number {
    const request = this.posted[index];
    if (request === undefined) throw new Error(`no request posted at ${index}`);
    return request.id;
  }

  reply(message: EngineMessage): void {
    this.messageListener(message);
  }

  exit(): void {
    this.exitListener();
  }
}

describe("EngineClient", () => {
  let port: FakeEnginePort;
  let client: EngineClient;

  beforeEach(() => {
    vi.useFakeTimers();
    port = new FakeEnginePort();
    client = new EngineClient({ port, timeoutMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the request and resolves with the value of the reply that carries its id", async () => {
    const version = client.request("version");

    expect(port.posted).toEqual([{ id: expect.any(Number), type: "version" }]);
    port.reply({ id: port.postedId(0), ok: true, value: "0.0.0" });
    await expect(version).resolves.toBe("0.0.0");
  });

  it("posts the payload with the request and resolves with the matching reply", async () => {
    const flow = { nodes: [], wires: [], session: { name: "main" } };
    const saved = client.request("save-flow", flow);

    expect(port.posted).toEqual([{ id: expect.any(Number), type: "save-flow", payload: flow }]);
    port.reply({
      id: port.postedId(0),
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 1 },
    });
    await expect(saved).resolves.toEqual({ kind: "saved", flowId: "flow-a", version: 1 });
  });

  it("posts a request made without a payload with no payload key", () => {
    void client.request("store-status");

    expect(port.posted).toHaveLength(1);
    expect(Object.hasOwn(port.posted[0] ?? {}, "payload")).toBe(false);
  });

  it("matches two concurrent requests to their own replies by id", async () => {
    const version = client.request("version");
    const status = client.request("store-status");

    expect(port.postedId(0)).not.toBe(port.postedId(1));
    port.reply({ id: port.postedId(1), ok: true, value: { kind: "ready" } });
    port.reply({ id: port.postedId(0), ok: true, value: "0.0.0" });
    await expect(version).resolves.toBe("0.0.0");
    await expect(status).resolves.toEqual({ kind: "ready" });
  });

  it("rejects a request that gets no reply once the timeout passes, naming the type and timeout", async () => {
    const version = client.request("version");
    const settled = expect(version).rejects.toThrow(/version.*100 ?ms/);

    await vi.advanceTimersByTimeAsync(100);

    await settled;
  });

  it("rejects every pending request when the engine exits", async () => {
    const version = client.request("version");
    const status = client.request("store-status");

    port.exit();

    await expect(version).rejects.toThrow(/exit/);
    await expect(status).rejects.toThrow(/exit/);
  });

  it("rejects a request made after the engine exited at once, without waiting for the timeout", async () => {
    port.exit();

    const version = client.request("version");

    await expect(version).rejects.toThrow("engine exited");
    expect(port.posted).toEqual([]);
  });

  it("rejects with the engine's error when the reply is not ok", async () => {
    const version = client.request("version");

    port.reply({ id: port.postedId(0), ok: false, error: "engine broke" });

    await expect(version).rejects.toThrow("engine broke");
  });

  describe("pushes", () => {
    const push = (runId: string): EnginePush => ({
      push: "run-state",
      value: { runId, status: "running", nodes: { p1: "waiting" } },
    });

    it("hands a push to every listener while no request is pending", () => {
      const first: EnginePush[] = [];
      const second: EnginePush[] = [];
      client.onPush((pushed) => first.push(pushed));
      client.onPush((pushed) => second.push(pushed));

      port.reply(push("run-1"));

      expect(first).toEqual([push("run-1")]);
      expect(second).toEqual([push("run-1")]);
    });

    it("hands a push to the listeners while a request is pending, without settling it", async () => {
      const pushes: EnginePush[] = [];
      client.onPush((pushed) => pushes.push(pushed));
      let settled = false;
      const version = client.request("version").finally(() => {
        settled = true;
      });

      port.reply(push("run-1"));
      await vi.advanceTimersByTimeAsync(0);

      expect(pushes).toEqual([push("run-1")]);
      expect(settled).toBe(false);
      port.reply({ id: port.postedId(0), ok: true, value: "0.0.0" });
      await expect(version).resolves.toBe("0.0.0");
    });

    it("stops handing pushes to a listener once it unsubscribes", () => {
      const pushes: EnginePush[] = [];
      const unsubscribe = client.onPush((pushed) => pushes.push(pushed));

      port.reply(push("run-1"));
      unsubscribe();
      port.reply(push("run-2"));

      expect(pushes).toEqual([push("run-1")]);
    });

    it("still drops a response with an unknown id, settling nothing and pushing nothing", async () => {
      const pushes: EnginePush[] = [];
      client.onPush((pushed) => pushes.push(pushed));
      let settled = false;
      void client.request("version").then(
        () => (settled = true),
        () => (settled = true),
      );

      port.reply({ id: port.postedId(0) + 100, ok: true, value: "stray" });
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(false);
      expect(pushes).toEqual([]);
    });
  });

  it("posts a start-run request and resolves with its matching reply", async () => {
    const started = client.request("start-run");

    expect(port.posted).toEqual([{ id: expect.any(Number), type: "start-run" }]);
    port.reply({ id: port.postedId(0), ok: true, value: { kind: "started", runId: "run-1" } });
    await expect(started).resolves.toEqual({ kind: "started", runId: "run-1" });
  });
});
