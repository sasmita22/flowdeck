import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";

type Handler = (event: unknown, ...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Handler[]>();
  const exposed: Record<string, unknown> = {};
  return {
    exposed,
    listeners,
    emit(channel: string, ...args: unknown[]) {
      for (const handler of [...(listeners.get(channel) ?? [])])
        handler({ sender: "ipc" }, ...args);
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string) => `answer for ${channel}`),
      send: vi.fn(),
      on: vi.fn((channel: string, handler: Handler) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      }),
      removeListener: vi.fn((channel: string, handler: Handler) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((registered) => registered !== handler),
        );
      }),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed[key] = api;
      }),
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

describe("preload run-state wiring", () => {
  let bridge: FlowdeckBridge;

  beforeAll(async () => {
    await import("../../../src/app/preload/preload.js");
    bridge = electron.exposed["flowdeck"] as FlowdeckBridge;
  });

  it("invokes flowdeck:start-run for startRun and returns its answer", async () => {
    await expect(bridge.startRun()).resolves.toBe("answer for flowdeck:start-run");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("flowdeck:start-run");
  });

  it("invokes flowdeck:get-run-state for getRunState and returns its answer", async () => {
    await expect(bridge.getRunState()).resolves.toBe("answer for flowdeck:get-run-state");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("flowdeck:get-run-state");
  });

  it("hands each flowdeck:run-state snapshot to the listener without the event", () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onRunState(listener);

    electron.emit("flowdeck:run-state", { runId: "run-1" });

    expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
      "flowdeck:run-state",
      expect.any(Function),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ runId: "run-1" });
    unsubscribe();
  });

  it("removes the same handler it registered on unsubscribe, so later snapshots are not handed on", () => {
    const listener = vi.fn();
    electron.ipcRenderer.on.mockClear();
    const unsubscribe = bridge.onRunState(listener);
    const registered = electron.ipcRenderer.on.mock.calls[0]?.[1];

    unsubscribe();
    electron.emit("flowdeck:run-state", { runId: "run-1" });

    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "flowdeck:run-state",
      registered,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
