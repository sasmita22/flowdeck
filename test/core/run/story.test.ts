import { describe, expect, it } from "vitest";
import { storyPartsOf } from "../../../src/core/run/story.js";

describe("storyPartsOf", () => {
  it("splits a three-part story into context, goal and result", () => {
    expect(storyPartsOf("Context: a\nGoal: b\nResult: c")).toEqual({
      context: "a",
      goal: "b",
      result: "c",
    });
  });

  it("keeps every line of a part up to the next label", () => {
    const text = [
      "Context: shop-repo on main.",
      "Tests were red before the run.",
      "Goal: fix the login test.",
      "Result: the test passes.",
      "Nothing was left undone.",
    ].join("\n");

    expect(storyPartsOf(text)).toEqual({
      context: "shop-repo on main.\nTests were red before the run.",
      goal: "fix the login test.",
      result: "the test passes.\nNothing was left undone.",
    });
  });

  it("trims each part", () => {
    expect(storyPartsOf("\nContext:   a  \n\nGoal:\n  b\n\nResult: c  \n")).toEqual({
      context: "a",
      goal: "b",
      result: "c",
    });
  });

  it.each([
    ["labels out of order", "Goal: b\nContext: a\nResult: c"],
    ["a label missing", "Context: a\nResult: c"],
    ["no labels", "The run fixed the login test on main and every test passes."],
  ])("returns undefined for %s", (_case, text) => {
    expect(storyPartsOf(text)).toBeUndefined();
  });
});
