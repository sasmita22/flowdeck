import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth, whatever order they were added in", () => {
    const expected = '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n';

    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(expected);
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe(expected);
  });

  it("keeps array order and sorts the keys of objects inside arrays", () => {
    expect(canonicalJson({ list: [3, 1, 2], items: [{ y: 1, x: 2 }] })).toBe(
      '{\n  "items": [\n    {\n      "x": 2,\n      "y": 1\n    }\n  ],\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n',
    );
  });

  it("leaves out members whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{\n  "a": 1\n}\n');
  });
});
