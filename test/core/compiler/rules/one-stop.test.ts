import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/one-stop.js";
import { agent, flow, output, thenWire, trigger } from "../../../fixtures/flow-builders.js";

const errorsOf = (input: ReturnType<typeof flow>) =>
  rule.check(input).map(({ rule, container }) => ({ rule, container }));

describe("one-stop", () => {
  it("refuses a container with two Stops, naming it", () => {
    const twoStops = flow(
      [trigger("start"), agent("a"), output("stop"), output("other")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("a", "other")],
    );

    expect(errorsOf(twoStops)).toEqual([{ rule: "one-stop", container: "session-1" }]);
  });

  it("accepts a workspace and a session with one Stop each", () => {
    const oneEach = flow(
      [trigger("start"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(rule.check(oneEach)).toEqual([]);
  });
});
