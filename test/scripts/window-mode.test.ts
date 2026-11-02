import { describe, expect, it } from "vitest";
import { hideWindow, withWindowMode } from "../../scripts/window-mode.js";

describe("hideWindow", () => {
  it.each([
    [{ CLAUDECODE: "1" }, true],
    [{ CLAUDECODE: "1", FLOWDECK_SHOW_WINDOW: "1" }, false],
    [{}, false],
    [{ FLOWDECK_HIDE_WINDOW: "1" }, true],
    [{ FLOWDECK_HIDE_WINDOW: "1", FLOWDECK_SHOW_WINDOW: "1" }, true],
    [{ CLAUDECODE: "0" }, false],
  ])("decides %o → hidden %s", (env, hidden) => {
    expect(hideWindow(env)).toBe(hidden);
  });
});

describe("withWindowMode", () => {
  it("tells the app to hide its window when an agent runs the tests", () => {
    expect(withWindowMode({ CLAUDECODE: "1", PATH: "/bin" })).toEqual({
      CLAUDECODE: "1",
      PATH: "/bin",
      FLOWDECK_HIDE_WINDOW: "1",
    });
  });

  it("drops an inherited hide flag for a person's run, so the window shows", () => {
    expect(withWindowMode({ FLOWDECK_HIDE_WINDOW: "", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
