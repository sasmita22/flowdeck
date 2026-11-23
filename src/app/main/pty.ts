import { assertSessionName } from "../../adapters/tmux/tmux-session-host.js";
import { terminalSizeSchema, type TerminalStatus } from "../../core/run/terminal.js";

export type PtyProcess = {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: () => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; env: Record<string, string> },
) => PtyProcess;

export type Terminal = {
  setSession(runId: string, name: string | null): void;
  setContainerSessions(runId: string, names: readonly string[]): void;
  status(runId: string): TerminalStatus;
  open(runId: string, size: unknown, tmuxName?: unknown): boolean;
  write(runId: string, data: unknown): void;
  resize(runId: string, size: unknown): void;
  close(runId: string): void;
  setPoppedOut(runId: string, poppedOut: boolean): void;
  dispose(): void;
};

type RunTerminal = {
  session: string | null;
  pty: PtyProcess | null;
  attached: string | null;
  announced: ReadonlySet<string>;
  poppedOut: boolean;
};

const isValidName = (name: string): boolean => {
  try {
    assertSessionName(name);
    return true;
  } catch {
    return false;
  }
};

const attachEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const kept = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && entry[0] !== "TMUX" && entry[0] !== "TMUX_PANE",
  );
  return { ...Object.fromEntries(kept), TERM: "xterm-256color" };
};

export function createTerminal(options: {
  spawn: PtySpawn;
  env: Record<string, string | undefined>;
  sendStatus: (runId: string, status: TerminalStatus) => void;
  sendData: (runId: string, data: string) => void;
}): Terminal {
  const runs = new Map<string, RunTerminal>();
  let disposed = false;

  const runOf = (runId: string): RunTerminal => {
    const existing = runs.get(runId);
    if (existing !== undefined) return existing;
    const created: RunTerminal = {
      session: null,
      pty: null,
      attached: null,
      announced: new Set(),
      poppedOut: false,
    };
    runs.set(runId, created);
    return created;
  };

  const status = (runId: string): TerminalStatus => {
    const run = runs.get(runId);
    return {
      available: run?.session != null,
      attached: run?.pty != null,
      ...(run?.poppedOut === true ? { poppedOut: true } : {}),
    };
  };
  const report = (runId: string) => options.sendStatus(runId, status(runId));

  const close = (runId: string) => {
    const run = runs.get(runId);
    if (run === undefined) return;
    const current = run.pty;
    run.pty = null;
    current?.kill();
    report(runId);
  };

  return {
    setSession(runId, name) {
      if (disposed) return;
      runOf(runId).session = name !== null && isValidName(name) ? name : null;
      report(runId);
    },
    setContainerSessions(runId, names) {
      if (disposed) return;
      runOf(runId).announced = new Set(names);
    },
    status,
    open(runId, size, tmuxName) {
      const run = runs.get(runId);
      if (disposed || run === undefined || run.session === null) return false;
      const parsed = terminalSizeSchema.safeParse(size);
      if (!parsed.success) return false;
      const target =
        typeof tmuxName === "string" && run.announced.has(tmuxName) && isValidName(tmuxName)
          ? tmuxName
          : run.session;
      if (run.pty !== null && run.attached === target) return true;
      const replaced = run.pty;
      run.pty = null;
      replaced?.kill();
      const spawned = options.spawn("tmux", ["-L", target, "attach-session", "-t", `=${target}`], {
        name: "xterm-256color",
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        env: attachEnv(options.env),
      });
      run.pty = spawned;
      run.attached = target;
      spawned.onData((data) => options.sendData(runId, data));
      spawned.onExit(() => {
        if (run.pty !== spawned) return;
        run.pty = null;
        report(runId);
      });
      report(runId);
      return true;
    },
    write(runId, data) {
      if (typeof data === "string") runs.get(runId)?.pty?.write(data);
    },
    resize(runId, size) {
      const parsed = terminalSizeSchema.safeParse(size);
      if (parsed.success) runs.get(runId)?.pty?.resize(parsed.data.cols, parsed.data.rows);
    },
    close,
    setPoppedOut(runId, value) {
      runOf(runId).poppedOut = value;
      report(runId);
    },
    dispose() {
      for (const runId of runs.keys()) close(runId);
      disposed = true;
    },
  };
}
