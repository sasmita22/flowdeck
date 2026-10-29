import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRequest, EngineResponse } from "../../../src/app/engine/protocol.js";
import { EngineClient, type EnginePort } from "../../../src/app/main/engine-client.js";

class FakeEnginePort implements EnginePort {
  readonly posted: EngineRequest[] = [];
  private messageListener: (response: EngineResponse) => void = () => undefined;
  private exitListener: () => void = () => undefined;

  postMessage(message: EngineRequest): void {
    this.posted.push(message);
  }

  onMessage(listener: (response: EngineResponse) => void): void {
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

  reply(response: EngineResponse): void {
    this.messageListener(response);
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
});
