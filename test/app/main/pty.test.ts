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

const setup = () => {
  const spawns: SpawnCall[] = [];
  const ptys: FakePty[] = [];
  const statuses: TerminalStatus[] = [];
  const data: string[] = [];
  const spawn: PtySpawn = (...call) => {
    spawns.push(call);
    const pty = fakePty();
    ptys.push(pty);
    return pty;
  };
  const terminal = createTerminal({
    spawn,
    env: { HOME: "/home/me", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", TERM: "screen" },
    sendStatus: (status) => statuses.push(status),
    sendData: (chunk) => data.push(chunk),
  });
  return { terminal, spawns, ptys, statuses, data };
};

const size = { cols: 100, rows: 30 };

const attached = () => {
  const context = setup();
  context.terminal.setSession("fd-run-1");
  context.terminal.open(size);
  const pty = context.ptys[0];
  if (!pty) throw new Error("open did not spawn");
  return { ...context, pty };
};

describe("setSession", () => {
  it("makes a valid fd-* session available without spawning anything", () => {
    const { terminal, spawns, statuses } = setup();

    terminal.setSession("fd-run-1");

    expect(statuses).toEqual([{ available: true, attached: false }]);
    expect(terminal.status()).toEqual({ available: true, attached: false });
    expect(spawns).toEqual([]);
  });

  it("leaves a session that is not fd-* unavailable", () => {
    const { terminal } = setup();

    terminal.setSession("main");

    expect(terminal.status()).toEqual({ available: false, attached: false });
  });

  it("sends available false on null while attached, without killing the attach", () => {
    const { terminal, pty, statuses } = attached();

    terminal.setSession(null);

    expect(statuses.at(-1)).toEqual({ available: false, attached: true });
    expect(pty.kills).toBe(0);
  });
});

describe("open", () => {
  it("spawns the tmux attach for the session at the given size and reports attached", () => {
    const { terminal, spawns, statuses } = setup();
    terminal.setSession("fd-run-1");

    const opened = terminal.open(size);

    expect(opened).toBe(true);
    expect(spawns).toHaveLength(1);
    const [file, args, options] = spawns[0] ?? [];
    expect(file).toBe("tmux");
    expect(args).toEqual(["-L", "fd-run-1", "attach-session", "-t", "=fd-run-1"]);
    expect(options).toMatchObject({ name: "xterm-256color", cols: 100, rows: 30 });
    expect(options?.env).toEqual({ HOME: "/home/me", TERM: "xterm-256color" });
    expect(statuses.at(-1)).toEqual({ available: true, attached: true });
  });

  it("returns false and spawns nothing when no session was ever set", () => {
    const { terminal, spawns } = setup();

    expect(terminal.open(size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it("returns false and spawns nothing after the session is cleared", () => {
    const { terminal, spawns } = setup();
    terminal.setSession("fd-run-1");
    terminal.setSession(null);

    expect(terminal.open(size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it("returns false and spawns nothing for a session that is not fd-*", () => {
    const { terminal, spawns } = setup();
    terminal.setSession("main");

    expect(terminal.open(size)).toBe(false);
    expect(spawns).toEqual([]);
  });

  it.each([[{ cols: 1.5, rows: 30 }], [{ cols: 100 }], ["100x30"], [null]])(
    "returns false and spawns nothing for the invalid size %j",
    (invalid) => {
      const { terminal, spawns } = setup();
      terminal.setSession("fd-run-1");

      expect(terminal.open(invalid)).toBe(false);
      expect(spawns).toEqual([]);
    },
  );

  it("returns true without a second spawn when already attached", () => {
    const { terminal, spawns } = attached();

    expect(terminal.open(size)).toBe(true);
    expect(spawns).toHaveLength(1);
  });
});

describe("close", () => {
  it("kills the attach once and keeps the session available", () => {
    const { terminal, pty, statuses } = attached();

    terminal.close();

    expect(pty.kills).toBe(1);
    expect(statuses.at(-1)).toEqual({ available: true, attached: false });
  });

  it("lets a later open spawn a new attach that an exit of the old one leaves alone", () => {
    const { terminal, pty, spawns, ptys } = attached();
    terminal.close();

    expect(terminal.open(size)).toBe(true);
    expect(spawns).toHaveLength(2);
    pty.emitExit();

    expect(terminal.status()).toEqual({ available: true, attached: true });
    terminal.write("hi");
    expect(ptys[1]?.writes).toEqual(["hi"]);
  });
});

describe("pty events", () => {
  it("hands the current attach's output to sendData", () => {
    const { pty, data } = attached();

    pty.emitData("x");

    expect(data).toEqual(["x"]);
  });

  it("reports detached when the attach exits by itself, and later writes reach no pty", () => {
    const { terminal, pty, statuses } = attached();

    pty.emitExit();
    terminal.write("hi");

    expect(statuses.at(-1)).toEqual({ available: true, attached: false });
    expect(terminal.status()).toEqual({ available: true, attached: false });
    expect(pty.writes).toEqual([]);
  });
});

describe("write", () => {
  it("forwards a string to the current attach and ignores anything else", () => {
    const { terminal, pty } = attached();

    terminal.write("hi");
    terminal.write(42);

    expect(pty.writes).toEqual(["hi"]);
  });

  it("does nothing with no attach", () => {
    const { terminal } = setup();
    terminal.setSession("fd-run-1");

    expect(() => terminal.write("hi")).not.toThrow();
  });
});

describe("resize", () => {
  it("clamps the size to at least 1x1", () => {
    const { terminal, pty } = attached();

    terminal.resize({ cols: 0, rows: -3 });

    expect(pty.resizes).toEqual([[1, 1]]);
  });

  it("forwards a valid size and ignores an invalid one", () => {
    const { terminal, pty } = attached();

    terminal.resize({ cols: 120, rows: 40 });
    terminal.resize("x");

    expect(pty.resizes).toEqual([[120, 40]]);
  });

  it("does nothing with no attach", () => {
    const { terminal } = setup();
    terminal.setSession("fd-run-1");

    expect(() => terminal.resize(size)).not.toThrow();
  });
});

describe("dispose", () => {
  it("kills the open attach, then refuses to open and ignores new sessions", () => {
    const { terminal, pty, spawns, statuses } = attached();

    terminal.dispose();
    const sentBefore = statuses.length;

    expect(pty.kills).toBe(1);
    expect(terminal.open(size)).toBe(false);
    terminal.setSession("fd-run-2");
    expect(statuses).toHaveLength(sentBefore);
    expect(spawns).toHaveLength(1);
  });
});
