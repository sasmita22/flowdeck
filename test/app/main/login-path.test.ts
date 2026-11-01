import { afterEach, describe, expect, it, vi } from "vitest";
import { loginPath, pathEndMarker, pathStartMarker } from "../../../src/app/main/login-path.js";

const loginShellPath = "/opt/homebrew/bin:/Users/u/.nvm/versions/node/v24/bin:/usr/bin:/bin";

const marked = (path: string) => `${pathStartMarker}${path}${pathEndMarker}`;

type ShellResult = { code: number | null; stdout: string };
type Run = (command: string, args: readonly string[]) => Promise<ShellResult>;

const runner = (result: ShellResult) => vi.fn<Run>(async () => result);

afterEach(() => {
  vi.useRealTimers();
});

describe("loginPath", () => {
  it("returns only the marked PATH when the profile prints around it", async () => {
    const run = runner({
      code: 0,
      stdout: `Last login: Mon Nov  2 09:00:00 on ttys001\nloading .zshrc\n${marked(loginShellPath)}\nbye\n`,
    });

    await expect(loginPath({ shell: "/bin/zsh", run, timeoutMs: 3000 })).resolves.toBe(
      loginShellPath,
    );
  });

  it("runs the shell as an interactive login shell that prints the PATH between the markers", async () => {
    const run = runner({ code: 0, stdout: marked(loginShellPath) });

    await loginPath({ shell: "/usr/local/bin/fish", run, timeoutMs: 3000 });

    expect(run).toHaveBeenCalledOnce();
    const [command, args] = run.mock.calls[0] ?? [];
    expect(command).toBe("/usr/local/bin/fish");
    expect(args?.[0]).toBe("-ilc");
    expect(args).toHaveLength(2);
    expect(args?.[1]).toContain(`${pathStartMarker}\${PATH}${pathEndMarker}`);
  });

  it("uses /bin/zsh when SHELL is unset", async () => {
    const run = runner({ code: 0, stdout: marked(loginShellPath) });

    await loginPath({ shell: undefined, run, timeoutMs: 3000 });

    expect(run.mock.calls[0]?.[0]).toBe("/bin/zsh");
  });

  it("returns undefined when the shell exits non-zero, even with the PATH printed", async () => {
    const run = runner({ code: 1, stdout: marked(loginShellPath) });

    await expect(loginPath({ shell: "/bin/zsh", run, timeoutMs: 3000 })).resolves.toBeUndefined();
  });

  it("returns undefined when the markers are missing", async () => {
    const run = runner({ code: 0, stdout: `${loginShellPath}\n` });

    await expect(loginPath({ shell: "/bin/zsh", run, timeoutMs: 3000 })).resolves.toBeUndefined();
  });

  it("returns undefined when the shell cannot be started", async () => {
    const run = vi.fn<Run>(async () => {
      throw new Error("spawn /bin/nope ENOENT");
    });

    await expect(loginPath({ shell: "/bin/nope", run, timeoutMs: 3000 })).resolves.toBeUndefined();
  });

  it("returns undefined once the timeout passes for a shell that never finishes", async () => {
    vi.useFakeTimers();
    const run = vi.fn<Run>(() => new Promise(() => undefined));
    let settled = false;
    const result = loginPath({ shell: "/bin/zsh", run, timeoutMs: 3000 }).then((path) => {
      settled = true;
      return path;
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeUndefined();
  });
});
