import { describe, expect, it } from "vitest";
import { parseVerdict } from "../../../src/core/run/verdict.js";

const fence = "```";
const block = (body: string) => `${fence}json\n${body}\n${fence}`;
const malformed = (reason: string) => ({ kind: "malformed", reason });

describe("parseVerdict", () => {
  it.each([true, false])("reads done %s from a json block after text", (done) => {
    expect(parseVerdict(`ok\n${block(`{"done": ${done}}`)}`)).toEqual({ kind: "verdict", done });
  });

  it("reads a block written on one line", () => {
    expect(parseVerdict(`${fence}json {"done": true} ${fence}`)).toEqual({
      kind: "verdict",
      done: true,
    });
  });

  it("takes the last json block", () => {
    const reply = `${block('{"done": true}')}\nthen\n${block('{"done": false}')}`;

    expect(parseVerdict(reply)).toEqual({ kind: "verdict", done: false });
  });

  it("ignores keys other than done", () => {
    expect(parseVerdict(block('{"done": true, "issues": 0}'))).toEqual({
      kind: "verdict",
      done: true,
    });
  });

  it("is malformed with no reply", () => {
    expect(parseVerdict(undefined)).toEqual(malformed("no reply"));
  });

  it.each(["", "all good", `${fence}js\n{"done": true}\n${fence}`])(
    "is malformed with no json block in %j",
    (reply) => {
      expect(parseVerdict(reply)).toEqual(malformed("no json block"));
    },
  );

  it("is malformed when the json block is not closed", () => {
    expect(parseVerdict(`${fence}json\n{"done": true}`)).toEqual(
      malformed("unterminated json block"),
    );
  });

  it("is malformed when the block is not valid json", () => {
    expect(parseVerdict(block("{done: true}"))).toEqual(malformed("invalid json"));
  });

  it.each(["{}", '{"done": "true"}', '{"done": 1}', '{"done": null}', "[true]", "true"])(
    "is malformed when the block holds %s",
    (body) => {
      expect(parseVerdict(block(body))).toEqual(malformed("done is not true or false"));
    },
  );
});
