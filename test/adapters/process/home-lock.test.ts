import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeLock } from "../../../src/adapters/process/home-lock.js";

const argsOf = (pid: number) =>
  execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();

describe("HomeLock", () => {
  let home: string;
  let lockPath: string;
  let others: ChildProcess[];

  const liveProcess = () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    others.push(child);
    return child.pid ?? 0;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-lock-"));
    lockPath = join(home, "engine.lock");
    others = [];
  });

  afterEach(async () => {
    for (const child of others) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  });

  it("takes a free home and writes this process into the lock", async () => {
    expect(await new HomeLock(lockPath).acquire()).toBe(true);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({
      pid: process.pid,
      args: argsOf(process.pid),
    });
  });

  it("refuses a home whose lock holder is still running", async () => {
    const pid = liveProcess();
    const held = JSON.stringify({ pid, args: argsOf(pid) });
    await writeFile(lockPath, held);

    expect(await new HomeLock(lockPath).acquire()).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(held);
  });

  it("takes over a lock whose holder has exited", async () => {
    const child = spawn("true");
    await new Promise((resolve) => child.once("exit", resolve));
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, args: "true" }));

    expect(await new HomeLock(lockPath).acquire()).toBe(true);
  });

  it("takes over a lock whose pid now belongs to some other program", async () => {
    const pid = liveProcess();
    await writeFile(lockPath, JSON.stringify({ pid, args: "Flowdeck Helper --type=utility" }));

    expect(await new HomeLock(lockPath).acquire()).toBe(true);
  });

  it("takes over an unreadable lock", async () => {
    await writeFile(lockPath, "not json");

    expect(await new HomeLock(lockPath).acquire()).toBe(true);
  });

  it("removes its own lock on release, and leaves another holder's lock alone", async () => {
    const lock = new HomeLock(lockPath);
    await lock.acquire();
    lock.release();
    await expect(readFile(lockPath, "utf8")).rejects.toThrow();

    const pid = liveProcess();
    const held = JSON.stringify({ pid, args: argsOf(pid) });
    await writeFile(lockPath, held);
    lock.release();
    expect(await readFile(lockPath, "utf8")).toBe(held);
  });
});
