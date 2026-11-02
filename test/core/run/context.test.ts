import { describe, expect, it } from "vitest";
import type { UsageEntry } from "../../../src/core/run/budget.js";
import {
  compactShare,
  contextFull,
  contextUse,
  contextWindowOf,
  contextWindows,
} from "../../../src/core/run/context.js";

const entry = (overrides: Partial<UsageEntry> = {}): UsageEntry => ({
  messageId: "m1",
  model: "claude-opus-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  ...overrides,
});

describe("context windows", () => {
  it("knows each model's window, a million tokens except Haiku 4.5", () => {
    expect(contextWindows).toEqual({
      "claude-fable-5-1": 1_000_000,
      "claude-mythos-5-1": 1_000_000,
      "claude-fable-5": 1_000_000,
      "claude-opus-5-5": 1_000_000,
      "claude-opus-5": 1_000_000,
      "claude-opus-4-8": 1_000_000,
      "claude-opus-4-7": 1_000_000,
      "claude-opus-4-6": 1_000_000,
      "claude-sonnet-5-5": 1_000_000,
      "claude-sonnet-5": 1_000_000,
      "claude-sonnet-4-6": 1_000_000,
      "claude-haiku-5-5": 1_000_000,
      "claude-haiku-4-5": 200_000,
    });
  });

  it("matches the longest model prefix, and takes the smallest window for a model it does not know", () => {
    expect(contextWindowOf("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowOf("claude-opus-5-5")).toBe(1_000_000);
    expect(contextWindowOf("claude-unknown-9")).toBe(200_000);
  });

  it("compacts at 80% of the window", () => {
    expect(compactShare).toBe(0.8);
  });
});

describe("context use", () => {
  it("reads the prompt size of the session's last main message", () => {
    const use = contextUse([
      entry({ messageId: "m1", inputTokens: 5, cacheReadTokens: 10 }),
      entry({
        messageId: "m2",
        inputTokens: 2_000,
        cacheWrite5mTokens: 30_000,
        cacheWrite1hTokens: 10_000,
        cacheReadTokens: 120_000,
        outputTokens: 999,
      }),
      entry({ messageId: "sub", inputTokens: 900_000, agentType: "fd-agent" }),
    ]);

    expect(use).toEqual({ messageId: "m2", tokens: 162_000, window: 1_000_000 });
  });

  it("has nothing to say before the session's first message", () => {
    expect(contextUse([])).toBeUndefined();
    expect(contextUse([entry({ agentType: "fd-agent" })])).toBeUndefined();
  });

  it("calls the context full from 80% of the window, and not below", () => {
    expect(contextFull({ messageId: "m", tokens: 800_000, window: 1_000_000 })).toBe(true);
    expect(contextFull({ messageId: "m", tokens: 799_999, window: 1_000_000 })).toBe(false);
    expect(contextFull({ messageId: "m", tokens: 160_000, window: 200_000 })).toBe(true);
  });
});
