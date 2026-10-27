import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionHost } from "../../ports/session-host.js";
import { TmuxSessionHost } from "./tmux-session-host.js";

const run = promisify(execFile);
const prefix = `fd-test-${process.pid}-`;
const invalidName = (name: string) =>
  `Invalid session name "${name}": must match ^fd-[A-Za-z0-9_-]+$`;

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run("tmux", args);
  return stdout;
}

async function rawSessions(): Promise<string[]> {
  try {
    return (await tmux("list-sessions", "-F", "#{session_name}")).split("\n").filter(Boolean);
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    if (/no server running on|error connecting to/.test(stderr)) return [];
    throw error;
  }
}

async function showEnvironment(name: string, variable: string): Promise<string> {
  try {
    return await tmux("show-environment", "-t", `=${name}:`, variable);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1 && "stderr" in error) {
      return String(error.stderr);
    }
    throw error;
  }
}

async function rawHas(name: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", `=${name}`);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<string> {
  for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${path} never appeared`);
}

async function waitForPane(
  host: SessionHost,
  name: string,
  done: (pane: string) => boolean,
): Promise<string> {
  let pane = await host.capture(name);
  for (let elapsed = 0; elapsed < 5000 && !done(pane); elapsed += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pane = await host.capture(name);
  }
  return pane;
}

const linesEqualTo = (pane: string, line: string) =>
  pane.split("\n").filter((candidate) => candidate === line).length;

describe("TmuxSessionHost", () => {
  let host: SessionHost;
  let tmp: string;

  beforeEach(async () => {
    host = new TmuxSessionHost();
    tmp = await mkdtemp(join(tmpdir(), "fd-test-"));
  });

  afterEach(async () => {
    for (const name of await rawSessions()) {
      if (name.startsWith(prefix)) await tmux("kill-session", "-t", `=${name}`);
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("starts a session that has() and tmux both see", async () => {
    await host.start(`${prefix}a`, tmp, "bash");

    expect(await host.has(`${prefix}a`)).toBe(true);
    expect(await rawSessions()).toContain(`${prefix}a`);
  });

  it("sets the given environment in the session, keeping spaces", async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "bash", { FLOWDECK_SOCK: "/tmp/fd sock/hook.sock" });

    expect(await showEnvironment(name, "FLOWDECK_SOCK")).toBe(
      "FLOWDECK_SOCK=/tmp/fd sock/hook.sock\n",
    );
  });

  it("sets no FLOWDECK_SOCK in a session started without environment", async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "bash");

    expect(await showEnvironment(name, "FLOWDECK_SOCK")).toBe("unknown variable: FLOWDECK_SOCK\n");
  });

  it("stops the session completely", async () => {
    await host.start(`${prefix}a`, tmp, "bash");

    await host.stop(`${prefix}a`);

    expect(await host.has(`${prefix}a`)).toBe(false);
    expect(await rawSessions()).not.toContain(`${prefix}a`);
  });

  it("refuses a duplicate start and leaves the first session untouched", async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "bash");
    const created = await tmux("display-message", "-p", "-t", `=${name}:`, "#{session_created}");

    await expect(host.start(name, tmp, "bash")).rejects.toThrow(`Session "${name}" already exists`);

    expect(await tmux("display-message", "-p", "-t", `=${name}:`, "#{session_created}")).toBe(
      created,
    );
  });

  it("runs the session in the given working folder", { timeout: 10_000 }, async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "bash");

    await tmux("send-keys", "-t", `=${name}:`, "pwd > out.txt", "Enter");

    const written = await waitForFile(join(tmp, "out.txt"));
    expect(await realpath(written.trim())).toBe(await realpath(tmp));
  });

  it("never lists or stops a session outside the fd- prefix", async () => {
    const other = `flowdeck-at5-${process.pid}`;
    await tmux("new-session", "-d", "-s", other);
    try {
      expect(await host.list()).not.toContain(other);
      await expect(host.stop(other)).rejects.toThrow(invalidName(other));
      expect(await rawHas(other)).toBe(true);
    } finally {
      await tmux("kill-session", "-t", `=${other}`);
    }
  });

  it("matches session names exactly, never by prefix", async () => {
    await host.start(`${prefix}ab`, tmp, "bash");

    expect(await host.has(`${prefix}a`)).toBe(false);

    await host.start(`${prefix}a`, tmp, "bash");
    await host.stop(`${prefix}a`);

    expect(await host.has(`${prefix}ab`)).toBe(true);
    expect(await rawSessions()).toContain(`${prefix}ab`);
  });

  it.each(["fd-x.y", "fd-x:y", "other"])("rejects the invalid name %s", async (name) => {
    const before = await rawSessions();

    await expect(host.start(name, tmp, "bash")).rejects.toThrow(invalidName(name));
    await expect(host.has(name)).rejects.toThrow(invalidName(name));
    await expect(host.stop(name)).rejects.toThrow(invalidName(name));

    expect(await rawSessions()).toEqual(before);
  });

  it("refuses a working folder that does not exist", async () => {
    const missing = join(tmp, "missing");

    await expect(host.start(`${prefix}c`, missing, "bash")).rejects.toThrow(
      `Working folder "${missing}" does not exist`,
    );
    expect(await host.has(`${prefix}c`)).toBe(false);
  });

  it("refuses a working folder that is a file", async () => {
    const file = join(tmp, "file.txt");
    await writeFile(file, "");

    await expect(host.start(`${prefix}c`, file, "bash")).rejects.toThrow(
      `Working folder "${file}" is not a folder`,
    );
    expect(await host.has(`${prefix}c`)).toBe(false);
  });

  it("refuses to stop a session that does not exist", async () => {
    await expect(host.stop(`${prefix}none`)).rejects.toThrow(
      `Session "${prefix}none" does not exist`,
    );
  });

  it("lists only fd- sessions, including one it started", async () => {
    await host.start(`${prefix}a`, tmp, "bash");

    const names = await host.list();

    expect(names).toContain(`${prefix}a`);
    expect(names.every((name) => name.startsWith("fd-"))).toBe(true);
  });

  it("types text literally and presses Enter after it", { timeout: 10_000 }, async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "cat");

    await host.sendText(name, "fd-echo-check");

    const pane = await waitForPane(host, name, (p) => linesEqualTo(p, "fd-echo-check") >= 2);
    expect(linesEqualTo(pane, "fd-echo-check")).toBe(2);
  });

  it("types text literally without pressing Enter", { timeout: 10_000 }, async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "cat");

    await host.typeText(name, "fd-typed-check");
    await waitForPane(host, name, (p) => linesEqualTo(p, "fd-typed-check") >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(linesEqualTo(await host.capture(name), "fd-typed-check")).toBe(1);
    await host.sendKey(name, "Enter");
    const pane = await waitForPane(host, name, (p) => linesEqualTo(p, "fd-typed-check") >= 2);
    expect(linesEqualTo(pane, "fd-typed-check")).toBe(2);
  });

  it("presses keys by name, not as text", { timeout: 10_000 }, async () => {
    const name = `${prefix}a`;
    await host.start(name, tmp, "cat");

    await host.sendKey(name, "Down");
    await host.sendKey(name, "Enter");

    const pane = await waitForPane(host, name, (p) => p.includes("^["));
    expect(pane.split("\n").some((line) => line.startsWith("^["))).toBe(true);
    expect(pane).not.toContain("Down");
  });

  it.each(["fd-x.y", "fd-x:y", "other"])(
    "rejects input and capture for the invalid name %s",
    async (name) => {
      await expect(host.sendText(name, "hi")).rejects.toThrow(invalidName(name));
      await expect(host.typeText(name, "hi")).rejects.toThrow(invalidName(name));
      await expect(host.sendKey(name, "Enter")).rejects.toThrow(invalidName(name));
      await expect(host.capture(name)).rejects.toThrow(invalidName(name));
    },
  );

  it("rejects input and capture for a session that does not exist", async () => {
    const missing = `Session "${prefix}none" does not exist`;

    await expect(host.sendText(`${prefix}none`, "hi")).rejects.toThrow(missing);
    await expect(host.typeText(`${prefix}none`, "hi")).rejects.toThrow(missing);
    await expect(host.sendKey(`${prefix}none`, "Enter")).rejects.toThrow(missing);
    await expect(host.capture(`${prefix}none`)).rejects.toThrow(missing);
  });

  describe("on its own tmux socket", () => {
    const socketName = `${prefix}own`;
    const own = new TmuxSessionHost({ socketName });
    const socketPathOf = async () =>
      (await tmux("-L", socketName, "display-message", "-p", "#{socket_path}")).trim();
    const exists = (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      );

    afterEach(async () => {
      for (const name of await own.list()) await own.stop(name);
    });

    it("removes the socket file when its last session stops", async () => {
      await own.start(`${prefix}a`, tmp, "bash");
      const socketPath = await socketPathOf();

      await own.stop(`${prefix}a`);

      expect(await exists(socketPath)).toBe(false);
    });

    it("keeps the socket file while another session still runs", async () => {
      await own.start(`${prefix}a`, tmp, "bash");
      await own.start(`${prefix}b`, tmp, "bash");
      const socketPath = await socketPathOf();

      await own.stop(`${prefix}a`);

      expect(await exists(socketPath)).toBe(true);
      await own.stop(`${prefix}b`);
      expect(await exists(socketPath)).toBe(false);
    });
  });

  it("never removes the default server's socket file", async () => {
    const tmuxTmpdir = process.env["TMUX_TMPDIR"];
    const outerTmux = process.env["TMUX"];
    process.env["TMUX_TMPDIR"] = await realpath(tmp);
    delete process.env["TMUX"];
    try {
      await host.start(`${prefix}a`, tmp, "bash");
      const socketPath = (await tmux("display-message", "-p", "#{socket_path}")).trim();

      await host.stop(`${prefix}a`);

      expect(await stat(socketPath).then(() => true)).toBe(true);
    } finally {
      if (tmuxTmpdir === undefined) delete process.env["TMUX_TMPDIR"];
      else process.env["TMUX_TMPDIR"] = tmuxTmpdir;
      if (outerTmux !== undefined) process.env["TMUX"] = outerTmux;
    }
  });

  it("reports nothing when no tmux server is running", async () => {
    const idle = new TmuxSessionHost({ socketName: `${prefix}noserver` });

    expect(await idle.list()).toEqual([]);
    expect(await idle.has(`${prefix}a`)).toBe(false);
  });
});
