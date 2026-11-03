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
  status(runId: string): TerminalStatus;
  open(runId: string, size: unknown): boolean;
  write(runId: string, data: unknown): void;
  resize(runId: string, size: unknown): void;
  close(runId: string): void;
  setPoppedOut(runId: string, poppedOut: boolean): void;
  dispose(): void;
};

type RunTerminal = { session: string | null; pty: PtyProcess | null; poppedOut: boolean };

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
    const created: RunTerminal = { session: null, pty: null, poppedOut: false };
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
    status,
    open(runId, size) {
      const run = runs.get(runId);
      if (disposed || run === undefined || run.session === null) return false;
      const parsed = terminalSizeSchema.safeParse(size);
      if (!parsed.success) return false;
      if (run.pty !== null) return true;
      const spawned = options.spawn(
        "tmux",
        ["-L", run.session, "attach-session", "-t", `=${run.session}`],
        {
          name: "xterm-256color",
          cols: parsed.data.cols,
          rows: parsed.data.rows,
          env: attachEnv(options.env),
        },
      );
      run.pty = spawned;
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
