import { describe, expect, it } from "vitest";
import { joinComplete, skippedBranches } from "../../../../src/core/nodes/join/execute.js";

const branchTypes = ["h:a1", "h:a2", "h:a3"];
const stopped = (...types: string[]) => new Set(types);

describe("joinComplete", () => {
  it.each([[[]], [["h:a1"]], [["h:a1", "h:a3"]]])(
    "waits for all while only %j have stopped",
    (types) => {
      expect(joinComplete("all", branchTypes, stopped(...types))).toBe(false);
    },
  );

  it("completes all once every branch type has stopped, in any order", () => {
    expect(joinComplete("all", branchTypes, stopped("h:a3", "h:a1", "h:a2"))).toBe(true);
  });

  it("does not count a duplicate stop of one type twice", () => {
    const seen = new Set<string>();
    for (const type of ["h:a1", "h:a1", "h:a2"]) seen.add(type);

    expect(joinComplete("all", branchTypes, seen)).toBe(false);
  });

  it("ignores a stopped type that is not a branch", () => {
    expect(
      joinComplete("all", branchTypes, stopped("h:a1", "h:a2", "general-purpose", "h:other")),
    ).toBe(false);
    expect(joinComplete("first", branchTypes, stopped("general-purpose"))).toBe(false);
  });

  it("waits for the first while nothing has stopped", () => {
    expect(joinComplete("first", branchTypes, stopped())).toBe(false);
  });

  it.each(branchTypes)("completes first once %s has stopped", (type) => {
    expect(joinComplete("first", branchTypes, stopped(type))).toBe(true);
  });
});

describe("skippedBranches", () => {
  it("returns the branches that have not stopped, in branch order", () => {
    expect(skippedBranches(["a1", "a2", "a3", "a4"], stopped("a4", "a2"))).toEqual(["a1", "a3"]);
  });

  it("skips nothing when every branch stopped", () => {
    expect(skippedBranches(["a1", "a2"], stopped("a1", "a2"))).toEqual([]);
  });

  it("ignores a stopped id that is not a branch", () => {
    expect(skippedBranches(["a1", "a2"], stopped("x", "a1"))).toEqual(["a2"]);
  });
});
