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
  setSession(name: string | null): void;
  status(): TerminalStatus;
  open(size: unknown): boolean;
  write(data: unknown): void;
  resize(size: unknown): void;
  close(): void;
  dispose(): void;
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
  sendStatus: (status: TerminalStatus) => void;
  sendData: (data: string) => void;
}): Terminal {
  let session: string | null = null;
  let pty: PtyProcess | null = null;
  let disposed = false;

  const status = (): TerminalStatus => ({ available: session !== null, attached: pty !== null });
  const report = () => options.sendStatus(status());

  const close = () => {
    const current = pty;
    pty = null;
    current?.kill();
    report();
  };

  return {
    setSession(name) {
      if (disposed) return;
      session = name !== null && isValidName(name) ? name : null;
      report();
    },
    status,
    open(size) {
      if (disposed || session === null) return false;
      const parsed = terminalSizeSchema.safeParse(size);
      if (!parsed.success) return false;
      if (pty !== null) return true;
      const spawned = options.spawn(
        "tmux",
        ["-L", session, "attach-session", "-t", `=${session}`],
        {
          name: "xterm-256color",
          cols: parsed.data.cols,
          rows: parsed.data.rows,
          env: attachEnv(options.env),
        },
      );
      pty = spawned;
      spawned.onData(options.sendData);
      spawned.onExit(() => {
        if (pty !== spawned) return;
        pty = null;
        report();
      });
      report();
      return true;
    },
    write(data) {
      if (typeof data === "string") pty?.write(data);
    },
    resize(size) {
      const parsed = terminalSizeSchema.safeParse(size);
      if (parsed.success) pty?.resize(parsed.data.cols, parsed.data.rows);
    },
    close,
    dispose() {
      close();
      disposed = true;
    },
  };
}
