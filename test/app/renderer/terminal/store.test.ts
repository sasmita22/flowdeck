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

const status = (available: boolean, attached: boolean) => ({ available, attached });

const setup = () => {
  const calls: string[] = [];
  let statusListener: (value: unknown) => void = () => undefined;
  let dataListener: (value: unknown) => void = () => undefined;
  const unsubscribeData = vi.fn();

  const bridge = {
    openTerminal: vi.fn<(size: { cols: number; rows: number }) => Promise<unknown>>(
      async () => true,
    ),
    getTerminalStatus: vi.fn<() => Promise<unknown>>(async () => {
      calls.push("getTerminalStatus");
      return status(false, false);
    }),
    writeTerminal: vi.fn<(data: string) => void>(),
    resizeTerminal: vi.fn<(size: { cols: number; rows: number }) => void>(),
    closeTerminal: vi.fn<() => void>(),
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
  const push = (value: unknown) => statusListener(value);
  const emitData = (value: unknown) => dataListener(value);
  const state = () => {
    const { available, attached, visible } = terminal.getState();
    return { available, attached, visible };
  };

  return { bridge, terminal, calls, push, emitData, unsubscribeData, state };
};

const connectedAvailable = async () => {
  const context = setup();
  context.bridge.getTerminalStatus.mockResolvedValueOnce(status(true, false));
  await context.terminal.getState().connect();
  return context;
};

describe("initial state", () => {
  it("starts unavailable, detached and hidden, with Open disabled", () => {
    const { terminal, state } = setup();

    expect(state()).toEqual({ available: false, attached: false, visible: false });
    expect(selectOpenDisabled(terminal.getState())).toBe(true);
  });
});

describe("connect", () => {
  it("subscribes to status pushes before asking for the current status", async () => {
    const { terminal, calls } = setup();

    await terminal.getState().connect();

    expect(calls).toEqual(["onTerminalStatus", "getTerminalStatus"]);
  });

  it("applies the status getTerminalStatus returns when no push came first", async () => {
    const { terminal, state } = await connectedAvailable();

    expect(state()).toEqual({ available: true, attached: false, visible: false });
    expect(selectOpenDisabled(terminal.getState())).toBe(false);
  });

  it("keeps a push that arrived before getTerminalStatus answered", async () => {
    const { bridge, terminal, push, state } = setup();
    const answer = deferred<unknown>();
    bridge.getTerminalStatus.mockReturnValueOnce(answer.promise);

    const connecting = terminal.getState().connect();
    push(status(true, false));
    answer.resolve(status(false, false));
    await connecting;

    expect(state().available).toBe(true);
  });

  it("ignores payloads that are not terminal statuses", async () => {
    const { bridge, terminal, push, state } = setup();
    bridge.getTerminalStatus.mockResolvedValueOnce({ available: "yes", attached: false });
    await terminal.getState().connect();

    expect(state().available).toBe(false);

    push(status(true, false));
    push({ available: false });
    push("detached");

    expect(state().available).toBe(true);
  });
});

describe("show", () => {
  it("makes the pane visible when a session is available", async () => {
    const { terminal, state } = await connectedAvailable();

    terminal.getState().show();

    expect(state().visible).toBe(true);
  });

  it("does nothing while no session is available", () => {
    const { terminal, state } = setup();

    terminal.getState().show();

    expect(state().visible).toBe(false);
  });

  it("does nothing when the pane is already visible", async () => {
    const { terminal } = await connectedAvailable();
    const listener = vi.fn();
    terminal.getState().show();
    terminal.subscribe(listener);

    terminal.getState().show();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("attach", () => {
  it("asks main to open the terminal at the size and keeps the pane on a true answer", async () => {
    const { bridge, terminal, state } = await connectedAvailable();
    terminal.getState().show();

    await terminal.getState().attach({ cols: 80, rows: 24 });

    expect(bridge.openTerminal).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(state().visible).toBe(true);
  });

  it.each([[false], [undefined], ["true"]])(
    "hides the pane when the answer is %j",
    async (answer) => {
      const { bridge, terminal, state } = await connectedAvailable();
      terminal.getState().show();
      bridge.openTerminal.mockResolvedValueOnce(answer);

      await terminal.getState().attach({ cols: 80, rows: 24 });

      expect(state().visible).toBe(false);
    },
  );
});

describe("status pushes", () => {
  it("hides the pane when the attach goes from attached to detached", async () => {
    const { terminal, push, state } = await connectedAvailable();
    terminal.getState().show();
    push(status(true, true));

    push(status(true, false));

    expect(state()).toEqual({ available: true, attached: false, visible: false });
  });

  it("keeps the pane visible on a detached push while it has never attached", async () => {
    const { terminal, push, state } = await connectedAvailable();
    terminal.getState().show();

    push(status(true, false));

    expect(state().visible).toBe(true);
  });
});

describe("close", () => {
  it("asks main to close the terminal and hides the pane", async () => {
    const { bridge, terminal, push, state } = await connectedAvailable();
    terminal.getState().show();
    push(status(true, true));

    terminal.getState().close();

    expect(bridge.closeTerminal).toHaveBeenCalledTimes(1);
    expect(state().visible).toBe(false);
  });
});

describe("input, resize and data", () => {
  it("sends typed input to writeTerminal", () => {
    const { bridge, terminal } = setup();

    terminal.getState().input("a");

    expect(bridge.writeTerminal).toHaveBeenCalledWith("a");
  });

  it("sends a pane size to resizeTerminal", () => {
    const { bridge, terminal } = setup();

    terminal.getState().resize({ cols: 120, rows: 40 });

    expect(bridge.resizeTerminal).toHaveBeenCalledWith({ cols: 120, rows: 40 });
  });

  it("passes only string output to the data listener and returns the bridge's unsubscribe", () => {
    const { terminal, emitData, unsubscribeData } = setup();
    const listener = vi.fn();

    const unsubscribe = terminal.getState().onData(listener);
    emitData("out");
    emitData(42);
    emitData({ data: "out" });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("out");
    expect(unsubscribeData).toHaveBeenCalledTimes(1);
  });
});
