import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/stop-required.js";
import { flow, output, prompt, thenWire, trigger } from "../../../fixtures/flow-builders.js";

describe("stop-required", () => {
  it("refuses a blueprint with no Stop", () => {
    expect(rule.check(flow([trigger("start"), prompt("a")], [thenWire("start", "a")]))).toEqual([
      { rule: "stop-required", message: "A blueprint needs a Stop on its main flow." },
    ]);
  });

  it.each([
    ["one Stop", [output("stop")]],
    ["two Stops", [output("stop"), output("other")]],
  ])("accepts %s", (_, stops) => {
    expect(rule.check(flow([trigger("start"), prompt("a"), ...stops], []))).toEqual([]);
  });
});
