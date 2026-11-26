import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endSessionsOfHome, sessionsOfHome } from "../../e2e/own-sessions.js";
import { openDatabase } from "../../src/adapters/sqlite/open-database.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { killTmuxServer } from "../fixtures/live-claude.js";

const run = promisify(execFile);
const prefix = `fd-test-${process.pid}-`;

describe("ending the tmux sessions of a test's home", () => {
  let tmp: string;
  let socketFolder: string;
  let home: string;
  let otherHome: string;
  let started: string[];
  let tmuxTmpdir: string | undefined;
  let outerTmux: string | undefined;
  let path: string | undefined;

  const start = async (name: string, env: Record<string, string> = {}) => {
    await new TmuxSessionHost({ socketName: name }).start(name, tmp, "bash", env);
    started.push(name);
  };
  const socketOf = (folder: string) => ({
    FLOWDECK_SOCK: join(folder, "sockets", "fd-build-a.sock"),
  });
  const answers = (name: string) =>
    run("tmux", ["-L", name, "has-session", "-t", `=${name}`]).then(
      () => true,
      () => false,
    );

  const recordRunSessions = (names: string[]) => {
    const db = openDatabase({ path: join(home, "flowdeck.db") });
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(
      "INSERT INTO run_sessions (run_id, tmux_name, cwd, claude_session_id, status) VALUES ('run', ?, ?, 'claude', 'open')",
    );
    for (const name of names) insert.run(name, tmp);
    db.close();
  };
  const die = (name: string) => run("tmux", ["-L", name, "kill-server"]);

  const useTmuxThatHangsOn = async (name: string, command: string) => {
    const tmux = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
    const bin = join(tmp, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "tmux"),
      `#!/bin/sh\nif [ "$2 $3" = "${name} ${command}" ]; then sleep 3; fi\nexec ${tmux} "$@"\n`,
    );
    await chmod(join(bin, "tmux"), 0o755);
    await run(join(bin, "tmux"), ["-V"]);
    process.env["PATH"] = `${bin}:${path}`;
  };

  beforeEach(async () => {
    tmuxTmpdir = process.env["TMUX_TMPDIR"];
    outerTmux = process.env["TMUX"];
    path = process.env["PATH"];
    tmp = await realpath(await mkdtemp(join(tmpdir(), "fd-test-")));
    process.env["TMUX_TMPDIR"] = tmp;
    delete process.env["TMUX"];
    socketFolder = join(tmp, `tmux-${process.getuid?.()}`);
    home = join(tmp, "home");
    otherHome = `${home}-other`;
    await mkdir(home);
    await mkdir(otherHome);
    started = [];
  });

  afterEach(async () => {
    process.env["PATH"] = path;
    const failures: unknown[] = [];
    for (const name of started) {
      await killTmuxServer(name).catch((error: unknown) => failures.push(error));
    }
    if (tmuxTmpdir === undefined) delete process.env["TMUX_TMPDIR"];
    else process.env["TMUX_TMPDIR"] = tmuxTmpdir;
    if (outerTmux !== undefined) process.env["TMUX"] = outerTmux;
    await rm(tmp, { recursive: true, force: true });
    if (failures.length > 0) throw new AggregateError(failures, "tmux servers left running");
  });

  it("finds only the session whose FLOWDECK_SOCK is under the home", async () => {
    await start(`${prefix}home`, socketOf(home));
    await start(`${prefix}other`, socketOf(otherHome));
    await start(`${prefix}none`);

    expect(await sessionsOfHome(home)).toEqual([`${prefix}home`]);
  });

  it("finds the home's session through a symlink to the home", async () => {
    await start(`${prefix}home`, socketOf(home));
    const link = join(tmp, "link");
    await symlink(home, link);

    expect(await sessionsOfHome(link)).toEqual([`${prefix}home`]);
  });

  it("still finds the session after the home is deleted", async () => {
    await start(`${prefix}home`, socketOf(home));
    await rm(home, { recursive: true });

    expect(await sessionsOfHome(home)).toEqual([`${prefix}home`]);
  });

  it("skips a dead socket with no server behind it", async () => {
    await start(`${prefix}home`, socketOf(home));
    await writeFile(join(socketFolder, `${prefix}dead`), "");

    expect(await sessionsOfHome(home)).toEqual([`${prefix}home`]);
  });

  it("ends the home's session and leaves another home's running", async () => {
    await start(`${prefix}home`, socketOf(home));
    await start(`${prefix}other`, socketOf(otherHome));

    await endSessionsOfHome(home);

    expect(await answers(`${prefix}home`)).toBe(false);
    expect(await readdir(socketFolder)).not.toContain(`${prefix}home`);
    expect(await answers(`${prefix}other`)).toBe(true);
  });

  it("removes the socket of a home session whose server died, and leaves other dead sockets", async () => {
    await start(`${prefix}gone`, socketOf(home));
    await start(`${prefix}stranger`, socketOf(home));
    await start(`${prefix}other`, socketOf(otherHome));
    recordRunSessions([`${prefix}gone`, `${prefix}other`]);
    await die(`${prefix}gone`);
    await die(`${prefix}stranger`);
    expect(await readdir(socketFolder)).toEqual(
      expect.arrayContaining([`${prefix}gone`, `${prefix}stranger`]),
    );

    await endSessionsOfHome(home);

    const left = await readdir(socketFolder);
    expect(left).not.toContain(`${prefix}gone`);
    expect(left).toContain(`${prefix}stranger`);
    expect(left).toContain(`${prefix}other`);
    expect(await answers(`${prefix}other`)).toBe(true);
  });

  it("fails naming the session when tmux does not answer in time", async () => {
    const bin = join(tmp, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "tmux"), "#!/bin/sh\nsleep 3\n");
    await chmod(join(bin, "tmux"), 0o755);
    await mkdir(socketFolder, { recursive: true, mode: 0o700 });
    await writeFile(join(socketFolder, `${prefix}slow`), "");
    process.env["PATH"] = `${bin}:${path}`;

    const startedAt = Date.now();
    await expect(sessionsOfHome(home, { timeoutMs: 200 })).rejects.toThrow(`${prefix}slow`);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses a home that is empty or the root, so it never matches every session", async () => {
    await start(`${prefix}home`, socketOf(home));

    await expect(sessionsOfHome("")).rejects.toThrow();
    await expect(sessionsOfHome("/")).rejects.toThrow();
    await expect(endSessionsOfHome("")).rejects.toThrow();
    expect(await answers(`${prefix}home`)).toBe(true);
  });

  it("still ends the home's session when another session does not answer, then fails naming it", async () => {
    await start(`${prefix}home`, socketOf(home));
    await mkdir(socketFolder, { recursive: true, mode: 0o700 });
    await writeFile(join(socketFolder, `${prefix}slow`), "");
    await useTmuxThatHangsOn(`${prefix}slow`, "show-environment");

    const startedAt = Date.now();
    await expect(endSessionsOfHome(home, { timeoutMs: 200 })).rejects.toThrow(
      `tmux session ${prefix}slow did not answer in 200 ms`,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await answers(`${prefix}home`)).toBe(false);
    expect(await readdir(socketFolder)).not.toContain(`${prefix}home`);
  });

  it("fails naming the home's session when it does not end in time and is still running", async () => {
    await start(`${prefix}home`, socketOf(home));
    await useTmuxThatHangsOn(`${prefix}home`, "kill-server");

    const startedAt = Date.now();
    const failure = await endSessionsOfHome(home, { timeoutMs: 200 }).catch(
      (error: Error) => error,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(String(failure)).toContain(`tmux session ${prefix}home did not answer in 200 ms`);
    expect(String(failure)).toContain(`${home} still has tmux sessions running: ${prefix}home`);
  });
});
