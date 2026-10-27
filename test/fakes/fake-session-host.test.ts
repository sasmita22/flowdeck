import { describe, expect, it } from "vitest";
import { FakeSessionHost } from "./fake-session-host.js";

const invalidName = (name: string) =>
  `Invalid session name "${name}": must match ^fd-[A-Za-z0-9_-]+$`;

describe("FakeSessionHost", () => {
  it("starts a session it can report and inspect", async () => {
    const host = new FakeSessionHost();

    await host.start("fd-a", "/work", "bash");

    expect(await host.has("fd-a")).toBe(true);
    expect(await host.list()).toContain("fd-a");
    expect(host.get("fd-a")).toEqual({ cwd: "/work", command: "bash" });
  });

  it("forgets a stopped session", async () => {
    const host = new FakeSessionHost();
    await host.start("fd-a", "/work", "bash");

    await host.stop("fd-a");

    expect(await host.has("fd-a")).toBe(false);
    expect(await host.list()).not.toContain("fd-a");
    expect(host.get("fd-a")).toBeUndefined();
  });

  it("refuses a duplicate start and keeps the first session", async () => {
    const host = new FakeSessionHost();
    await host.start("fd-a", "/work", "bash");

    await expect(host.start("fd-a", "/other", "zsh")).rejects.toThrow(
      'Session "fd-a" already exists',
    );
    expect(host.get("fd-a")).toEqual({ cwd: "/work", command: "bash" });
  });

  it.each(["fd-x.y", "fd-x:y", "other"])("rejects the invalid name %s", async (name) => {
    const host = new FakeSessionHost();

    await expect(host.start(name, "/work", "bash")).rejects.toThrow(invalidName(name));
    await expect(host.has(name)).rejects.toThrow(invalidName(name));
    await expect(host.stop(name)).rejects.toThrow(invalidName(name));
  });

  it("refuses to stop a session that does not exist", async () => {
    await expect(new FakeSessionHost().stop("fd-none")).rejects.toThrow(
      'Session "fd-none" does not exist',
    );
  });

  it("does not check that the working folder exists", async () => {
    const host = new FakeSessionHost();

    await host.start("fd-a", "/does/not/exist", "bash");

    expect(await host.has("fd-a")).toBe(true);
  });

  it("starts with no sessions", async () => {
    expect(await new FakeSessionHost().list()).toEqual([]);
  });
});
