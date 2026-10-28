import { describe, expect, it } from "vitest";
import { resolveFlowdeckHome } from "../../../src/app/main/flowdeck-home.js";

describe("resolveFlowdeckHome", () => {
  it("uses FLOWDECK_HOME when it is set", () => {
    expect(resolveFlowdeckHome({ FLOWDECK_HOME: "/x" }, "/home/u")).toBe("/x");
  });

  it("falls back to .flowdeck in the home folder", () => {
    expect(resolveFlowdeckHome({}, "/home/u")).toBe("/home/u/.flowdeck");
  });
});
