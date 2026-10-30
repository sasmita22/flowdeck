import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createWindowGuard } from "../../../src/app/main/window-guard.js";

const packagedUrl =
  "file:///Applications/Flowdeck.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html";
const devUrl = "http://localhost:5173";

const topFrame = (url: string) => ({ url, parent: null });
const subFrame = (url: string) => ({ url, parent: topFrame(url) });
const ipcEvent = (senderFrame: { url: string; parent: unknown } | null) => ({ senderFrame });

describe("createWindowGuard", () => {
  describe("packaged app", () => {
    let guard: ReturnType<typeof createWindowGuard>;

    beforeEach(() => {
      guard = createWindowGuard({ appUrl: packagedUrl });
    });

    it("accepts the top frame at the app's exact file URL", () => {
      expect(guard.isAppFrame(topFrame(packagedUrl))).toBe(true);
    });

    it("accepts the top frame at the app's file URL with a hash", () => {
      expect(guard.isAppFrame(topFrame(`${packagedUrl}#/flow`))).toBe(true);
    });

    it("refuses a missing frame", () => {
      expect(guard.isAppFrame(null)).toBe(false);
    });

    it("refuses a subframe at the app's URL", () => {
      expect(guard.isAppFrame(subFrame(packagedUrl))).toBe(false);
    });

    it.each([
      ["another file path", "file:///Users/someone/evil.html"],
      ["a remote page", "https://example.com/"],
      ["an unparseable URL", "not a url"],
    ])("refuses a top frame at %s", (_label, url) => {
      expect(guard.isAppFrame(topFrame(url))).toBe(false);
    });

    it("allows navigation to the app's own URL", () => {
      expect(guard.allowsNavigation(packagedUrl)).toBe(true);
    });

    it.each([
      ["a remote page", "https://example.com/"],
      ["another file path", "file:///Users/someone/evil.html"],
    ])("blocks navigation to %s", (_label, url) => {
      expect(guard.allowsNavigation(url)).toBe(false);
    });
  });

  describe("dev app", () => {
    let guard: ReturnType<typeof createWindowGuard>;

    beforeEach(() => {
      guard = createWindowGuard({ appUrl: devUrl });
    });

    it("accepts the top frame at the dev server origin", () => {
      expect(guard.isAppFrame(topFrame("http://localhost:5173/"))).toBe(true);
    });

    it.each([
      ["a host that only starts with the dev host", "http://localhost:5173.evil.com/"],
      ["another port", "http://localhost:5174/"],
      ["another scheme", "https://localhost:5173/"],
    ])("refuses a top frame at %s", (_label, url) => {
      expect(guard.isAppFrame(topFrame(url))).toBe(false);
    });

    it("allows navigation to the dev server's own URL", () => {
      expect(guard.allowsNavigation("http://localhost:5173/")).toBe(true);
    });

    it.each([
      ["a remote page", "https://example.com/"],
      ["a file path", "file:///Users/someone/evil.html"],
    ])("blocks navigation to %s", (_label, url) => {
      expect(guard.allowsNavigation(url)).toBe(false);
    });
  });

  describe("windows and IPC", () => {
    let guard: ReturnType<typeof createWindowGuard>;
    let save: Mock<(...args: unknown[]) => string>;

    beforeEach(() => {
      guard = createWindowGuard({ appUrl: packagedUrl });
      save = vi.fn<(...args: unknown[]) => string>(() => "saved");
    });

    it("denies every new window", () => {
      expect(guard.denyWindowOpen()).toEqual({ action: "deny" });
    });

    it.each([
      ["a missing frame", null],
      ["a subframe", subFrame(packagedUrl)],
      ["another URL", topFrame("https://example.com/")],
    ])("rejects an invoke from %s without running the handler", (_label, frame) => {
      const handler = guard.handle(save);

      expect(() => handler(ipcEvent(frame), { id: "flow-1" })).toThrow();
      expect(save).not.toHaveBeenCalled();
    });

    it("runs the handler for an invoke from the app frame with its arguments", () => {
      const handler = guard.handle(save);
      const flow = { id: "flow-1" };

      const result = handler(ipcEvent(topFrame(packagedUrl)), flow, 2);

      expect(result).toBe("saved");
      expect(save).toHaveBeenCalledExactlyOnceWith(flow, 2);
    });

    it.each([
      ["a missing frame", null],
      ["a subframe", subFrame(packagedUrl)],
      ["another URL", topFrame("https://example.com/")],
    ])("drops a message from %s", (_label, frame) => {
      const listener = guard.listen(save);

      expect(() => listener(ipcEvent(frame), true)).not.toThrow();
      expect(save).not.toHaveBeenCalled();
    });

    it("delivers a message from the app frame with its arguments", () => {
      const listener = guard.listen(save);

      listener(ipcEvent(topFrame(packagedUrl)), true);

      expect(save).toHaveBeenCalledExactlyOnceWith(true);
    });
  });
});
