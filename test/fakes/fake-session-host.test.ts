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

  it("records the environment a session was started with", async () => {
    const host = new FakeSessionHost();

    await host.start("fd-x", "/work", "bash", { FLOWDECK_SOCK: "/s" });
    await host.start("fd-y", "/work", "bash");

    expect(host.get("fd-x")?.env).toEqual({ FLOWDECK_SOCK: "/s" });
    expect(host.get("fd-y")?.env).toBeUndefined();
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

  it("records text and keys in the order they were sent", async () => {
    const host = new FakeSessionHost();
    await host.start("fd-a", "/work", "bash");

    await host.sendKey("fd-a", "Down");
    await host.sendText("fd-a", "hello");
    await host.sendKey("fd-a", "Enter");

    expect(host.inputs("fd-a")).toEqual([{ key: "Down" }, { text: "hello" }, { key: "Enter" }]);
  });

  it("captures an empty pane until one is set", async () => {
    const host = new FakeSessionHost();
    await host.start("fd-a", "/work", "bash");

    expect(await host.capture("fd-a")).toBe("");

    host.setPane("fd-a", "❯ ready");

    expect(await host.capture("fd-a")).toBe("❯ ready");
  });

  it("tells a listener about each input after recording it", async () => {
    const host = new FakeSessionHost();
    await host.start("fd-a", "/work", "bash");
    const seen: unknown[] = [];
    host.onInput("fd-a", (input) => {
      seen.push([input, host.inputs("fd-a").length]);
      if ("key" in input && input.key === "Enter") host.setPane("fd-a", "after enter");
    });

    await host.sendText("fd-a", "hi");
    await host.sendKey("fd-a", "Enter");

    expect(seen).toEqual([
      [{ text: "hi" }, 1],
      [{ key: "Enter" }, 2],
    ]);
    expect(await host.capture("fd-a")).toBe("after enter");
  });

  it.each(["fd-x.y", "fd-x:y", "other"])(
    "rejects input and capture for the invalid name %s",
    async (name) => {
      const host = new FakeSessionHost();

      await expect(host.sendText(name, "hi")).rejects.toThrow(invalidName(name));
      await expect(host.sendKey(name, "Enter")).rejects.toThrow(invalidName(name));
      await expect(host.capture(name)).rejects.toThrow(invalidName(name));
    },
  );

  it("rejects input and capture for a session it does not hold", async () => {
    const host = new FakeSessionHost();
    const missing = 'Session "fd-none" does not exist';

    await expect(host.sendText("fd-none", "hi")).rejects.toThrow(missing);
    await expect(host.sendKey("fd-none", "Enter")).rejects.toThrow(missing);
    await expect(host.capture("fd-none")).rejects.toThrow(missing);
  });
});
