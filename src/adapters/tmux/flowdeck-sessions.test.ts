import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flowdeckSessionNames, sessionSocketPath } from "./flowdeck-sessions.js";
import { TmuxSessionHost } from "./tmux-session-host.js";

const prefix = `fd-test-${process.pid}-`;

describe("flowdeck tmux sessions", () => {
  let tmp: string;
  let socketFolder: string;
  let started: string[];
  let tmuxTmpdir: string | undefined;
  let outerTmux: string | undefined;

  const start = async (name: string, env: Record<string, string> = {}) => {
    await new TmuxSessionHost({ socketName: name }).start(name, tmp, "bash", env);
    started.push(name);
  };

  beforeEach(async () => {
    tmuxTmpdir = process.env["TMUX_TMPDIR"];
    outerTmux = process.env["TMUX"];
    tmp = await realpath(await mkdtemp(join(tmpdir(), "fd-test-")));
    process.env["TMUX_TMPDIR"] = tmp;
    delete process.env["TMUX"];
    socketFolder = join(tmp, `tmux-${process.getuid?.()}`);
    started = [];
  });

  afterEach(async () => {
    try {
      for (const name of started) await new TmuxSessionHost({ socketName: name }).stop(name);
    } finally {
      if (tmuxTmpdir === undefined) delete process.env["TMUX_TMPDIR"];
      else process.env["TMUX_TMPDIR"] = tmuxTmpdir;
      if (outerTmux !== undefined) process.env["TMUX"] = outerTmux;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("lists the sockets of the live fd- sessions and nothing else in the socket folder", async () => {
    await start(`${prefix}a`);
    await start(`${prefix}b`);
    await writeFile(join(socketFolder, "other"), "");

    expect((await flowdeckSessionNames()).sort()).toEqual([`${prefix}a`, `${prefix}b`]);
  });

  it("lists nothing when the socket folder does not exist", async () => {
    expect(await flowdeckSessionNames()).toEqual([]);
  });

  it("reads the FLOWDECK_SOCK a session was started with", async () => {
    await start(`${prefix}a`, { FLOWDECK_SOCK: "/fd-home/sockets/fd-run-a.sock" });

    expect(await sessionSocketPath(`${prefix}a`)).toBe("/fd-home/sockets/fd-run-a.sock");
  });

  it("reads no socket from a session started without FLOWDECK_SOCK", async () => {
    await start(`${prefix}a`);

    expect(await sessionSocketPath(`${prefix}a`)).toBeUndefined();
  });

  it("rejects for a stale socket with no server behind it", async () => {
    await mkdir(socketFolder, { recursive: true, mode: 0o700 });
    await writeFile(join(socketFolder, `${prefix}stale`), "");

    await expect(sessionSocketPath(`${prefix}stale`)).rejects.toThrow();
  });
});
