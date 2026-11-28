import { describe, expect, it } from "vitest";
import { parseProducedValues, parseVerdict } from "../../../src/core/run/verdict.js";

const fence = "```";
const block = (body: string) => `${fence}json\n${body}\n${fence}`;

describe("parseProducedValues", () => {
  it.each([
    [true, "yes"],
    [false, "no"],
  ])("reads %s, a %s answer, under the variable's own key after text", (answer) => {
    expect(
      parseProducedValues(`Checked.\n${block(`{"tests-passed": ${answer}}`)}`, ["tests-passed"]),
    ).toEqual({ values: { "tests-passed": answer }, missing: [] });
  });

  it("reads several variables from one final block", () => {
    expect(
      parseProducedValues(block('{"approved": true, "docs": false}'), ["approved", "docs"]),
    ).toEqual({ values: { approved: true, docs: false }, missing: [] });
  });

  it("returns the values it read and names the ones that are missing", () => {
    expect(
      parseProducedValues(block('{"approved": true, "docs": "no"}'), ["approved", "docs", "ship"]),
    ).toEqual({ values: { approved: true }, missing: ["docs", "ship"] });
  });

  it("takes the last json block", () => {
    const reply = `${block('{"tests-passed": true}')}\nthen\n${block('{"tests-passed": false}')}`;

    expect(parseProducedValues(reply, ["tests-passed"])).toEqual({
      values: { "tests-passed": false },
      missing: [],
    });
  });

  it("reads its keys beside a Loop's done in one block, leaving done to parseVerdict", () => {
    const reply = block('{"done": false, "tests-passed": true}');

    expect(parseProducedValues(reply, ["tests-passed"])).toEqual({
      values: { "tests-passed": true },
      missing: [],
    });
    expect(parseVerdict(reply)).toEqual({ kind: "verdict", done: false });
  });

  it.each([
    ["only done", '{"done": true}'],
    ["another variable's key", '{"approved": true}'],
    ["a number", '{"tests-passed": 1}'],
    ["null", '{"tests-passed": null}'],
    ["a list", "[true]"],
    ["invalid json", "{tests-passed: true"],
  ])("names the variable missing from a block holding %s", (_, body) => {
    expect(parseProducedValues(block(body), ["tests-passed"])).toEqual({
      values: {},
      missing: ["tests-passed"],
    });
  });

  it.each([
    ["no reply", undefined],
    ["no json block", "Tests passed."],
  ])("names every variable missing with %s", (_, reply) => {
    expect(parseProducedValues(reply, ["approved", "docs"])).toEqual({
      values: {},
      missing: ["approved", "docs"],
    });
  });

  it("reads nothing and misses nothing when no variable is asked", () => {
    expect(parseProducedValues("DONE", [])).toEqual({ values: {}, missing: [] });
  });
});
