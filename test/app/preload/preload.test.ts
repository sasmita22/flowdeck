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

describe("preload terminal wiring", () => {
  let bridge: FlowdeckBridge;

  beforeAll(async () => {
    await import("../../../src/app/preload/preload.js");
    bridge = electron.exposed["flowdeck"] as FlowdeckBridge;
  });

  it("invokes flowdeck:open-terminal with the size for openTerminal and returns its answer", async () => {
    await expect(bridge.openTerminal({ cols: 80, rows: 24 })).resolves.toBe(
      "answer for flowdeck:open-terminal",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("flowdeck:open-terminal", {
      cols: 80,
      rows: 24,
    });
  });

  it("invokes flowdeck:get-terminal-status for getTerminalStatus and returns its answer", async () => {
    await expect(bridge.getTerminalStatus()).resolves.toBe(
      "answer for flowdeck:get-terminal-status",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("flowdeck:get-terminal-status");
  });

  it("sends flowdeck:terminal-input with the data for writeTerminal", () => {
    bridge.writeTerminal("a");

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith("flowdeck:terminal-input", "a");
  });

  it("sends flowdeck:terminal-resize with the size for resizeTerminal", () => {
    bridge.resizeTerminal({ cols: 120, rows: 40 });

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith("flowdeck:terminal-resize", {
      cols: 120,
      rows: 40,
    });
  });

  it("sends flowdeck:close-terminal for closeTerminal", () => {
    bridge.closeTerminal();

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith("flowdeck:close-terminal");
  });

  it.each([
    ["onTerminalStatus", "flowdeck:terminal-status", { available: true, attached: false }],
    ["onTerminalData", "flowdeck:terminal-data", "output"],
  ] as const)(
    "%s hands each %s payload to the listener without the event, and stops after unsubscribe",
    (method, channel, payload) => {
      const listener = vi.fn();
      electron.ipcRenderer.on.mockClear();
      const unsubscribe = bridge[method](listener);
      const registered = electron.ipcRenderer.on.mock.calls[0]?.[1];

      electron.emit(channel, payload);

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);

      unsubscribe();
      electron.emit(channel, payload);

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registered);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );
});
