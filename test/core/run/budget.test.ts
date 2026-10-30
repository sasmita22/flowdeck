import { describe, expect, it } from "vitest";
import { budgetReached, costOf, usd, type UsageEntry } from "../../../src/core/run/budget.js";

const entry = (fields: Partial<UsageEntry>): UsageEntry => ({
  messageId: "m1",
  model: "claude-opus-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  ...fields,
});

const million = 1_000_000;

describe("costOf", () => {
  it("prices output tokens at the model's output rate", () => {
    expect(costOf([entry({ outputTokens: 60_000 })])).toBeCloseTo(1.2, 10);
  });

  it("counts a message id once, keeping its last entry", () => {
    const cost = costOf([
      entry({ messageId: "m1", outputTokens: 10_000 }),
      entry({ messageId: "m1", outputTokens: 60_000 }),
    ]);

    expect(cost).toBeCloseTo(1.2, 10);
  });

  it("counts two message ids twice", () => {
    const cost = costOf([
      entry({ messageId: "m1", outputTokens: 60_000 }),
      entry({ messageId: "m2", outputTokens: 60_000 }),
    ]);

    expect(cost).toBeCloseTo(2.4, 10);
  });

  it.each<[string, number, number, number]>([
    ["claude-fable-5-1", 10, 50, 0.25],
    ["claude-mythos-5-1", 10, 50, 0.25],
    ["claude-fable-5", 10, 50, 1],
    ["claude-opus-5-5", 4, 20, 0.2],
    ["claude-opus-5", 5, 25, 0.5],
    ["claude-opus-4-8", 5, 25, 0.5],
    ["claude-opus-4-7", 5, 25, 0.5],
    ["claude-opus-4-6", 5, 25, 0.5],
    ["claude-sonnet-5-5", 2, 10, 0.2],
    ["claude-sonnet-5", 2, 10, 0.2],
    ["claude-sonnet-4-6", 3, 15, 0.3],
    ["claude-haiku-5-5", 0.1, 0.5, 0.01],
    ["claude-haiku-4-5", 1, 5, 0.1],
  ])("prices %s at $%s in, $%s out, $%s cache read per MTok", (model, input, output, read) => {
    const cost = costOf([
      entry({ model, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 }),
    ]);

    expect(cost).toBeCloseTo((input + output + read) / 1000, 10);
  });

  it.each([
    ["claude-haiku-4-5-20251001", 1],
    ["claude-opus-5-5-20261001", 4],
    ["claude-opus-5-5-x", 4],
    ["claude-opus-5-20260101", 5],
    ["claude-fable-5-1-20261001", 10],
  ])("prices the dated id %s by its longest known prefix", (model, perMillionInput) => {
    expect(costOf([entry({ model, inputTokens: million })])).toBeCloseTo(perMillionInput, 10);
  });

  it.each(["gpt-5", "<synthetic>", "claude-unknown-9"])(
    "prices the unknown model %s at Fable rates",
    (model) => {
      expect(costOf([entry({ model })])).toBe(0);
      expect(costOf([entry({ model, inputTokens: million })])).toBeCloseTo(10, 10);
    },
  );

  it.each<[string, Partial<UsageEntry>, number]>([
    ["a 5 minute cache write at 1.25 times input", { cacheWrite5mTokens: million }, 5],
    ["a 1 hour cache write at 2 times input", { cacheWrite1hTokens: million }, 8],
    ["a cache read at the cache read rate", { cacheReadTokens: million }, 0.2],
    [
      "all three together",
      { cacheWrite5mTokens: million, cacheWrite1hTokens: million, cacheReadTokens: million },
      13.2,
    ],
  ])("prices %s", (_name, tokens, expected) => {
    expect(costOf([entry({ model: "claude-opus-5-5", ...tokens })])).toBeCloseTo(expected, 10);
  });

  describe("claude-haiku-5-5 long prompts", () => {
    const haiku = (tokens: Partial<UsageEntry>) =>
      costOf([entry({ model: "claude-haiku-5-5", outputTokens: 10_000, ...tokens })]);

    it("keeps the short rate at exactly 100K prompt tokens", () => {
      expect(haiku({ inputTokens: 50_000, cacheReadTokens: 50_000 })).toBeCloseTo(
        (50_000 * 0.1 + 10_000 * 0.5 + 50_000 * 0.01) / million,
        10,
      );
    });

    it("switches to the long rate once input and cache read pass 100K", () => {
      expect(haiku({ inputTokens: 50_001, cacheReadTokens: 50_000 })).toBeCloseTo(
        (50_001 * 0.5 + 10_000 * 2.5 + 50_000 * 0.05) / million,
        10,
      );
    });

    it("counts cache writes towards the 100K", () => {
      expect(
        haiku({ inputTokens: 1000, cacheWrite5mTokens: 49_500, cacheWrite1hTokens: 49_501 }),
      ).toBeCloseTo(
        (1000 * 0.5 + 10_000 * 2.5 + 49_500 * 0.5 * 1.25 + 49_501 * 0.5 * 2) / million,
        10,
      );
    });
  });
});

describe("budgetReached", () => {
  it.each([
    [1.2, 1, true],
    [1, 1, true],
    [0.99, 1, false],
  ])("spend %s of budget %s is reached: %s", (spend, budget, reached) => {
    expect(budgetReached(spend, budget)).toBe(reached);
  });
});

describe("usd", () => {
  it.each([
    [1.2, "$1.20"],
    [0.00034, "$0.0003"],
  ])("formats %s as %s", (amount, shown) => {
    expect(usd(amount)).toBe(shown);
  });
});
