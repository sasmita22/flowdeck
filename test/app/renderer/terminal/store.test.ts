import { describe, expect, it, vi } from "vitest";
import {
  createTerminalStore,
  selectOpenDisabled,
  type TerminalBridge,
} from "../../../../src/app/renderer/terminal/store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type Size = { cols: number; rows: number };

const status = (available: boolean, attached: boolean) => ({ available, attached });

const setup = () => {
  const calls: string[] = [];
  let statusListener: (value: unknown) => void = () => undefined;
  let dataListener: (value: unknown) => void = () => undefined;
  const unsubscribeData = vi.fn();

  const bridge = {
    openTerminal: vi.fn<(runId: string, size: Size) => Promise<unknown>>(async () => true),
    getTerminalStatus: vi.fn<(runId: string) => Promise<unknown>>(async (runId) => {
      calls.push(`getTerminalStatus ${runId}`);
      return status(false, false);
    }),
    writeTerminal: vi.fn<(runId: string, data: string) => void>(),
    resizeTerminal: vi.fn<(runId: string, size: Size) => void>(),
    closeTerminal: vi.fn<(runId: string) => void>(),
    popOutTerminal: vi.fn<(runId: string) => Promise<unknown>>(async () => true),
    onTerminalStatus: vi.fn((listener: (value: unknown) => void) => {
      calls.push("onTerminalStatus");
      statusListener = listener;
      return () => {};
    }),
    onTerminalData: vi.fn((listener: (value: unknown) => void) => {
      dataListener = listener;
      return unsubscribeData;
    }),
  } satisfies TerminalBridge;

  const terminal = createTerminalStore({ bridge });
  const push = (runId: string, value: unknown) => statusListener({ runId, status: value });
  const emitData = (value: unknown) => dataListener(value);
  const state = () => {
    const { available, attached, visible } = terminal.getState();
    return { available, attached, visible };
  };

  return { bridge, terminal, calls, push, emitData, unsubscribeData, state };
};

const viewing = async (runId = "run-1") => {
  const context = setup();
  context.bridge.getTerminalStatus.mockResolvedValueOnce(status(true, false));
  await context.terminal.getState().connect();
  await context.terminal.getState().view(runId);
  return context;
};

describe("initial state", () => {
  it("starts on no run, unavailable, detached and hidden, with Open disabled", () => {
    const { terminal, state } = setup();

    expect(terminal.getState().runId).toBeNull();
    expect(state()).toEqual({ available: false, attached: false, visible: false });
    expect(selectOpenDisabled(terminal.getState())).toBe(true);
  });
});

describe("view", () => {
  it("subscribes to status pushes, then asks for the viewed run's status", async () => {
    const { terminal, calls } = setup();

    await terminal.getState().connect();
    await terminal.getState().view("run-1");

    expect(calls).toEqual(["onTerminalStatus", "getTerminalStatus run-1"]);
    expect(terminal.getState().runId).toBe("run-1");
  });

  it("applies the viewed run's status", async () => {
    const { terminal, state } = await viewing();

    expect(state()).toEqual({ available: true, attached: false, visible: false });
    expect(selectOpenDisabled(terminal.getState())).toBe(false);
  });

  it("keeps a push for the viewed run that arrived before its status answered", async () => {
    const { bridge, terminal, push, state } = setup();
    await terminal.getState().connect();
    const answer = deferred<unknown>();
    bridge.getTerminalStatus.mockReturnValueOnce(answer.promise);

    const viewed = terminal.getState().view("run-1");
    push("run-1", status(true, false));
    answer.resolve(status(false, false));
    await viewed;

    expect(state().available).toBe(true);
  });

  it("switching to another run starts hidden and follows that run's status", async () => {
    const { bridge, terminal, state } = await viewing("run-1");
    terminal.getState().show();
    bridge.getTerminalStatus.mockResolvedValueOnce(status(false, false));

    await terminal.getState().view("run-2");

    expect(terminal.getState().runId).toBe("run-2");
    expect(state()).toEqual({ available: false, attached: false, visible: false });
  });

  it("closes the attach of the run it switches away from before viewing the next one", async () => {
    const { bridge, terminal, push, calls } = await viewing("run-1");
    push("run-1", status(true, true));
    bridge.closeTerminal.mockImplementation((runId) => calls.push(`closeTerminal ${runId}`));

    await terminal.getState().view("run-2");

    expect(bridge.closeTerminal).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(calls.slice(-2)).toEqual(["closeTerminal run-1", "getTerminalStatus run-2"]);
  });

  it.each([
    ["is not attached", status(true, false), "run-2"],
    ["is popped out to its own window", { ...status(true, true), poppedOut: true }, "run-2"],
    ["is viewed again", status(true, true), "run-1"],
  ])("leaves the previous run's terminal open when it %s", async (_case, previous, next) => {
    const { bridge, terminal, push } = await viewing("run-1");
    push("run-1", previous);

    await terminal.getState().view(next);

    expect(bridge.closeTerminal).not.toHaveBeenCalled();
  });

  it("ignores a late status answer for a run no longer viewed", async () => {
    const { bridge, terminal, state } = setup();
    await terminal.getState().connect();
    const late = deferred<unknown>();
    bridge.getTerminalStatus.mockReturnValueOnce(late.promise);
    bridge.getTerminalStatus.mockResolvedValueOnce(status(false, false));

    const first = terminal.getState().view("run-1");
    await terminal.getState().view("run-2");
    late.resolve(status(true, true));
    await first;

    expect(terminal.getState().runId).toBe("run-2");
    expect(state().available).toBe(false);
  });
});

describe("status pushes", () => {
  it("follows only the viewed run's pushes", async () => {
    const { terminal, push, state } = await viewing("run-1");

    push("run-2", status(false, false));
    expect(state().available).toBe(true);

    push("run-1", status(false, false));
    expect(state().available).toBe(false);
    expect(terminal.getState().runId).toBe("run-1");
  });

  it("ignores payloads that are not a run's terminal status", async () => {
    const { push, state } = await viewing("run-1");

    push("run-1", { available: "yes", attached: false });
    push("run-1", "detached");

    expect(state().available).toBe(true);
  });

  it("hides the pane when the viewed run's attach goes from attached to detached", async () => {
    const { terminal, push, state } = await viewing();
    terminal.getState().show();
    push("run-1", status(true, true));

    push("run-1", status(true, false));

    expect(state()).toEqual({ available: true, attached: false, visible: false });
  });

  it("keeps the pane visible on a detached push while it has never attached", async () => {
    const { terminal, push, state } = await viewing();
    terminal.getState().show();

    push("run-1", status(true, false));

    expect(state().visible).toBe(true);
  });
});

describe("show", () => {
  it("makes the pane visible when the viewed run's session is available", async () => {
    const { terminal, state } = await viewing();

    terminal.getState().show();

    expect(state().visible).toBe(true);
  });

  it("does nothing while no session is available", () => {
    const { terminal, state } = setup();

    terminal.getState().show();

    expect(state().visible).toBe(false);
  });
});

describe("attach", () => {
  it("opens the viewed run's terminal at the size and keeps the pane on a true answer", async () => {
    const { bridge, terminal, state } = await viewing("run-1");
    terminal.getState().show();

    await terminal.getState().attach({ cols: 80, rows: 24 });

    expect(bridge.openTerminal).toHaveBeenCalledWith("run-1", { cols: 80, rows: 24 });
    expect(state().visible).toBe(true);
  });

  it("opens the other run's terminal after switching to it", async () => {
    const { bridge, terminal } = await viewing("run-1");
    bridge.getTerminalStatus.mockResolvedValueOnce(status(true, false));
    await terminal.getState().view("run-2");

    await terminal.getState().attach({ cols: 80, rows: 24 });

    expect(bridge.openTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.openTerminal).toHaveBeenCalledWith("run-2", { cols: 80, rows: 24 });
  });

  it("opens nothing while no run is viewed", async () => {
    const { bridge, terminal } = setup();

    await terminal.getState().attach({ cols: 80, rows: 24 });

    expect(bridge.openTerminal).not.toHaveBeenCalled();
  });

  it.each([[false], [undefined], ["true"]])(
    "hides the pane when the answer is %j",
    async (answer) => {
      const { bridge, terminal, state } = await viewing();
      terminal.getState().show();
      bridge.openTerminal.mockResolvedValueOnce(answer);

      await terminal.getState().attach({ cols: 80, rows: 24 });

      expect(state().visible).toBe(false);
    },
  );
});

describe("close", () => {
  it("closes the viewed run's terminal and hides the pane", async () => {
    const { bridge, terminal, push, state } = await viewing("run-1");
    terminal.getState().show();
    push("run-1", status(true, true));

    terminal.getState().close();

    expect(bridge.closeTerminal).toHaveBeenCalledWith("run-1");
    expect(state().visible).toBe(false);
  });
});

describe("input, resize and data", () => {
  it("sends typed input and pane sizes to the viewed run's terminal", async () => {
    const { bridge, terminal } = await viewing("run-1");

    terminal.getState().input("a");
    terminal.getState().resize({ cols: 120, rows: 40 });

    expect(bridge.writeTerminal).toHaveBeenCalledWith("run-1", "a");
    expect(bridge.resizeTerminal).toHaveBeenCalledWith("run-1", { cols: 120, rows: 40 });
  });

  it("passes only the viewed run's string output to the listener and returns the bridge's unsubscribe", async () => {
    const { terminal, emitData, unsubscribeData } = await viewing("run-1");
    const listener = vi.fn();

    const unsubscribe = terminal.getState().onData(listener);
    emitData({ runId: "run-1", data: "out" });
    emitData({ runId: "run-2", data: "other" });
    emitData({ runId: "run-1", data: 42 });
    emitData("out");
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("out");
    expect(unsubscribeData).toHaveBeenCalledTimes(1);
  });
});

describe("pop out", () => {
  it("pops out the viewed run's terminal, and follows whether a window holds it", async () => {
    const { bridge, terminal, push } = await viewing("run-1");

    await terminal.getState().popOut();
    push("run-1", { available: true, attached: true, poppedOut: true });

    expect(bridge.popOutTerminal).toHaveBeenCalledWith("run-1");
    expect(terminal.getState().poppedOut).toBe(true);

    push("run-1", status(true, false));
    expect(terminal.getState().poppedOut).toBe(false);
  });
});
