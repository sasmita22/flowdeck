import { describe, expect, it } from "vitest";
import { terminalSizeSchema, terminalStatusSchema } from "../../../src/core/run/terminal.js";

describe("terminalSizeSchema", () => {
  it("parses a valid size unchanged", () => {
    expect(terminalSizeSchema.parse({ cols: 100, rows: 30 })).toEqual({ cols: 100, rows: 30 });
  });

  it.each([
    [
      { cols: 0, rows: 0 },
      { cols: 1, rows: 1 },
    ],
    [
      { cols: -5, rows: 30 },
      { cols: 1, rows: 30 },
    ],
    [
      { cols: 80, rows: -1 },
      { cols: 80, rows: 1 },
    ],
  ])("clamps %j to %j", (input, expected) => {
    expect(terminalSizeSchema.parse(input)).toEqual(expected);
  });

  it.each([
    { cols: 80.5, rows: 24 },
    { cols: 80, rows: 24.1 },
    { cols: "80", rows: 24 },
    { cols: 80 },
    { rows: 24 },
    "80x24",
    null,
    80,
  ])("rejects %j", (value) => {
    expect(terminalSizeSchema.safeParse(value).success).toBe(false);
  });
});

describe("terminalStatusSchema", () => {
  it.each([
    { available: true, attached: true },
    { available: true, attached: false },
    { available: false, attached: false },
  ])("accepts %j", (value) => {
    expect(terminalStatusSchema.parse(value)).toEqual(value);
  });

  it.each([
    { available: "yes", attached: false },
    { available: true },
    { attached: true },
    { available: true, attached: 1 },
    null,
    true,
  ])("rejects %j", (value) => {
    expect(terminalStatusSchema.safeParse(value).success).toBe(false);
  });
});
