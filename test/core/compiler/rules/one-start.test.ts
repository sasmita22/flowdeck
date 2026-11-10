import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/one-start.js";
import { agent, flow, output, thenWire, trigger } from "../../../fixtures/flow-builders.js";

describe("one-start", () => {
  it("refuses a blueprint with no Start", () => {
    expect(rule.check(flow([agent("a"), output("stop")], [thenWire("a", "stop")]))).toEqual([
      { rule: "one-start", message: "A blueprint needs exactly one Start; it has none." },
    ]);
  });

  it("refuses a blueprint with two Starts", () => {
    const twoStarts = flow(
      [trigger("start"), trigger("again"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(rule.check(twoStarts)).toEqual([
      { rule: "one-start", message: "A blueprint needs exactly one Start; it has 2." },
    ]);
  });

  it.each([
    ["wired", [thenWire("start", "a"), thenWire("a", "stop")]],
    ["loose", []],
  ])("accepts one Start, %s", (_, wires) => {
    expect(rule.check(flow([trigger("start"), agent("a"), output("stop")], wires))).toEqual([]);
  });
});
