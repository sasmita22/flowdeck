import { describe, expect, it } from "vitest";
import { parseProducedValue, parseVerdict } from "../../../src/core/run/verdict.js";

const fence = "```";
const block = (body: string) => `${fence}json\n${body}\n${fence}`;
const notRead = { kind: "malformed", reason: expect.any(String) as string };

describe("parseProducedValue", () => {
  it.each([
    [true, "yes"],
    [false, "no"],
  ])("reads %s, a %s answer, under the value's own key after text", (answer) => {
    expect(
      parseProducedValue(`Checked.\n${block(`{"tests-passed": ${answer}}`)}`, "tests-passed"),
    ).toEqual({ kind: "value", answer });
  });

  it("takes the last json block", () => {
    const reply = `${block('{"tests-passed": true}')}\nthen\n${block('{"tests-passed": false}')}`;

    expect(parseProducedValue(reply, "tests-passed")).toEqual({ kind: "value", answer: false });
  });

  it("reads its key beside a Loop's done in one block, leaving done to parseVerdict", () => {
    const reply = block('{"done": false, "tests-passed": true}');

    expect(parseProducedValue(reply, "tests-passed")).toEqual({ kind: "value", answer: true });
    expect(parseVerdict(reply)).toEqual({ kind: "verdict", done: false });
  });

  it.each([
    ["only done", '{"done": true}'],
    ["another value's key", '{"approved": true}'],
    ["a number", '{"tests-passed": 1}'],
    ["null", '{"tests-passed": null}'],
    ["a list", "[true]"],
    ["invalid json", "{tests-passed: true"],
  ])("does not read an answer from a block holding %s", (_, body) => {
    expect(parseProducedValue(block(body), "tests-passed")).toEqual(notRead);
  });

  it.each([
    ["no reply", undefined],
    ["no json block", "Tests passed."],
  ])("does not read an answer with %s", (_, reply) => {
    expect(parseProducedValue(reply, "tests-passed")).toEqual(notRead);
  });
});
