import { describe, expect, it } from "vitest";
import type { TerminalStatus } from "../../../src/core/run/terminal.js";
import { createTerminal, type PtyProcess, type PtySpawn } from "../../../src/app/main/pty.js";

type FakePty = PtyProcess & {
  writes: string[];
  resizes: [number, number][];
  kills: number;
  emitData(data: string): void;
  emitExit(): void;
};

type SpawnCall = Parameters<PtySpawn>;

const fakePty = (): FakePty => {
  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: (() => void)[] = [];
  const pty: FakePty = {
    writes: [],
    resizes: [],
    kills: 0,
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    write: (data) => {
      pty.writes.push(data);
    },
    resize: (cols, rows) => {
      pty.resizes.push([cols, rows]);
    },
    kill: () => {
      pty.kills += 1;
    },
    emitData: (data) => dataListeners.forEach((listener) => listener(data)),
    emitExit: () => exitListeners.forEach((listener) => listener()),
  };
  return pty;
};

type StatusUpdate = { runId: string; status: TerminalStatus };

type DataUpdate = { runId: string; data: string };

const setup = () => {
  const spawns: SpawnCall[] = [];
  const ptys: FakePty[] = [];
  const statuses: StatusUpdate[] = [];
  const data: DataUpdate[] = [];
  const spawn: PtySpawn = (...call) => {
    spawns.push(call);
    const pty = fakePty();
    ptys.push(pty);
    return pty;
  };
  const terminal = createTerminal({
    spawn,
    env: { HOME: "/home/me", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", TERM: "screen" },
    sendStatus: (runId, status) => statuses.push({ runId, status }),
    sendData: (runId, chunk) => data.push({ runId, data: chunk }),
  });
  return { terminal, spawns, ptys, statuses, data };
};

const size = { cols: 100, rows: 30 };

const attached = () => {
  const context = setup();
  context.terminal.setSession("run-1", "fd-run-1");
  context.terminal.open("run-1", size);
  const pty = context.ptys[0];
  if (!pty) throw new Error("open did not spawn");
  return { ...context, pty };
};

const twoAttached = () => {
  const context = attached();
  context.terminal.setSession("run-2", "fd-run-2");
  context.terminal.open("run-2", size);
  const second = context.ptys[1];
  if (!second) throw new Error("open did not spawn a second attach");
  return { ...context, first: context.pty, second };
};

describe("setSession", () => {
  it("makes a valid fd-* session available for its run without spawning anything", () => {
    const { terminal, spawns, statuses } = setup();

    terminal.setSession("run-1", "fd-run-1");

    expect(statuses).toEqual([{ runId: "run-1", status: { available: true, attached: false } }]);
    expect(terminal.status("run-1")).toEqual({ available: true, attached: false });
    expect(spawns).toEqual([]);
  });

  it("leaves a session that is not fd-* unavailable", () => {
    const { terminal } = setup();

    terminal.setSession("run-1", "main");

    expect(terminal.status("run-1")).toEqual({ available: false, attached: false });
  });

  it("leaves another run unavailable", () => {
    const { terminal } = setup();

    terminal.setSession("run-1", "fd-run-1");

    expect(terminal.status("run-2")).toEqual({ available: false, attached: false });
  });

  it("sends available false on null while attached, without killing the attach", () => {
    const { terminal, pty, statuses } = attached();

    terminal.setSession("run-1", null);

    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: false, attached: true },
    });
    expect(pty.kills).toBe(0);
  });

  it("keeps the first run's session when a second run's session arrives", () => {
    const { terminal } = setup();

    terminal.setSession("run-1", "fd-run-1");
    terminal.setSession("run-2", "fd-run-2");

    expect(terminal.status("run-1")).toEqual({ available: true, attached: false });
    expect(terminal.status("run-2")).toEqual({ available: true, attached: false });
  });
});

describe("open", () => {
  it("spawns the tmux attach for the run's session at the given size and reports attached", () => {
    const { terminal, spawns, statuses } = setup();
    terminal.setSession("run-1", "fd-run-1");

    const opened = terminal.open("run-1", size);

    expect(opened).toBe(true);
    expect(spawns).toHaveLength(1);
    const [file, args, options] = spawns[0] ?? [];
    expect(file).toBe("tmux");
    expect(args).toEqual(["-L", "fd-run-1", "attach-session", "-t", "=fd-run-1"]);
    expect(options).toMatchObject({ name: "xterm-256color", cols: 100, rows: 30 });
    expect(options?.env).toEqual({ HOME: "/home/me", TERM: "xterm-256color" });
    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: true, attached: true },
    });
  });

  it("attaches each run to its own session, both open at once", () => {
    const { terminal, spawns, first } = twoAttached();

    expect(spawns.map(([, args]) => args)).toEqual([
      ["-L", "fd-run-1", "attach-session", "-t", "=fd-run-1"],
      ["-L", "fd-run-2", "attach-session", "-t", "=fd-run-2"],
    ]);
    expect(first.kills).toBe(0);
    expect(terminal.status("run-1")).toEqual({ available: true, attached: true });
    expect(terminal.status("run-2")).toEqual({ available: true, attached: true });
  });

  it("returns false and spawns nothing for a run whose session was never set", () => {
    const { terminal, spawns } = setup();
    terminal.setSession("run-1", "fd-run-1");

    expect(terminal.open("run-2", size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it("returns false and spawns nothing after the run's session is cleared", () => {
    const { terminal, spawns } = setup();
    terminal.setSession("run-1", "fd-run-1");
    terminal.setSession("run-1", null);

    expect(terminal.open("run-1", size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it("returns false and spawns nothing for a session that is not fd-*", () => {
    const { terminal, spawns } = setup();
    terminal.setSession("run-1", "main");

    expect(terminal.open("run-1", size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it.each([[{ cols: 1.5, rows: 30 }], [{ cols: 100 }], ["100x30"], [null]])(
    "returns false and spawns nothing for the invalid size %j",
    (invalid) => {
      const { terminal, spawns } = setup();
      terminal.setSession("run-1", "fd-run-1");

      expect(terminal.open("run-1", invalid)).toBe(false);
      expect(spawns).toEqual([]);
    },
  );

  it("returns true without a second spawn when the run is already attached", () => {
    const { terminal, spawns } = attached();

    expect(terminal.open("run-1", size)).toBe(true);
    expect(spawns).toHaveLength(1);
  });
});

describe("close", () => {
  it("kills the run's attach once and keeps its session available", () => {
    const { terminal, pty, statuses } = attached();

    terminal.close("run-1");

    expect(pty.kills).toBe(1);
    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: true, attached: false },
    });
  });

  it("leaves another run's attach open", () => {
    const { terminal, first, second } = twoAttached();

    terminal.close("run-1");

    expect(first.kills).toBe(1);
    expect(second.kills).toBe(0);
    expect(terminal.status("run-2")).toEqual({ available: true, attached: true });
  });

  it("lets a later open spawn a new attach that an exit of the old one leaves alone", () => {
    const { terminal, pty, spawns, ptys } = attached();
    terminal.close("run-1");

    expect(terminal.open("run-1", size)).toBe(true);
    expect(spawns).toHaveLength(2);
    pty.emitExit();

    expect(terminal.status("run-1")).toEqual({ available: true, attached: true });
    terminal.write("run-1", "hi");
    expect(ptys[1]?.writes).toEqual(["hi"]);
  });
});

describe("pty events", () => {
  it("hands each attach's output to sendData under its own run", () => {
    const { first, second, data } = twoAttached();

    first.emitData("x");
    second.emitData("y");

    expect(data).toEqual([
      { runId: "run-1", data: "x" },
      { runId: "run-2", data: "y" },
    ]);
  });

  it("reports detached when the attach exits by itself, and later writes reach no pty", () => {
    const { terminal, pty, statuses } = attached();

    pty.emitExit();
    terminal.write("run-1", "hi");

    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: true, attached: false },
    });
    expect(terminal.status("run-1")).toEqual({ available: true, attached: false });
    expect(pty.writes).toEqual([]);
  });

  it("leaves another run attached when one run's attach exits", () => {
    const { terminal, first } = twoAttached();

    first.emitExit();

    expect(terminal.status("run-1")).toEqual({ available: true, attached: false });
    expect(terminal.status("run-2")).toEqual({ available: true, attached: true });
  });
});

describe("write", () => {
  it("forwards a string to the run's attach and ignores anything else", () => {
    const { terminal, pty } = attached();

    terminal.write("run-1", "hi");
    terminal.write("run-1", 42);

    expect(pty.writes).toEqual(["hi"]);
  });

  it("reaches only the named run's attach", () => {
    const { terminal, first, second } = twoAttached();

    terminal.write("run-2", "hi");

    expect(first.writes).toEqual([]);
    expect(second.writes).toEqual(["hi"]);
  });

  it("does nothing with no attach", () => {
    const { terminal } = setup();
    terminal.setSession("run-1", "fd-run-1");

    expect(() => terminal.write("run-1", "hi")).not.toThrow();
  });
});

describe("resize", () => {
  it("clamps the size to at least 1x1", () => {
    const { terminal, pty } = attached();

    terminal.resize("run-1", { cols: 0, rows: -3 });

    expect(pty.resizes).toEqual([[1, 1]]);
  });

  it("forwards a valid size and ignores an invalid one", () => {
    const { terminal, pty } = attached();

    terminal.resize("run-1", { cols: 120, rows: 40 });
    terminal.resize("run-1", "x");

    expect(pty.resizes).toEqual([[120, 40]]);
  });

  it("resizes only the named run's attach", () => {
    const { terminal, first, second } = twoAttached();

    terminal.resize("run-2", { cols: 120, rows: 40 });

    expect(first.resizes).toEqual([]);
    expect(second.resizes).toEqual([[120, 40]]);
  });

  it("does nothing with no attach", () => {
    const { terminal } = setup();
    terminal.setSession("run-1", "fd-run-1");

    expect(() => terminal.resize("run-1", size)).not.toThrow();
  });
});

describe("dispose", () => {
  it("kills every open attach, then refuses to open and ignores new sessions", () => {
    const { terminal, first, second, spawns, statuses } = twoAttached();

    terminal.dispose();
    const sentBefore = statuses.length;

    expect(first.kills).toBe(1);
    expect(second.kills).toBe(1);
    expect(terminal.open("run-1", size)).toBe(false);
    terminal.setSession("run-3", "fd-run-3");
    expect(statuses).toHaveLength(sentBefore);
    expect(spawns).toHaveLength(2);
  });
});

describe("setPoppedOut", () => {
  it("reports the run's terminal as popped out while its own window holds it, and not after", () => {
    const { terminal, statuses } = twoAttached();

    terminal.setPoppedOut("run-1", true);
    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: true, attached: true, poppedOut: true },
    });
    expect(terminal.status("run-1")).toEqual({ available: true, attached: true, poppedOut: true });
    expect(terminal.status("run-2")).toEqual({ available: true, attached: true });

    terminal.setPoppedOut("run-1", false);
    expect(statuses.at(-1)).toEqual({
      runId: "run-1",
      status: { available: true, attached: true },
    });
  });
});
