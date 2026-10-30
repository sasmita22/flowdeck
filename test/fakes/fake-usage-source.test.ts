import { describe, expect, it } from "vitest";
import type { UsageEntry } from "../../src/ports/usage-source.js";
import { FakeUsageSource } from "./fake-usage-source.js";

const entry = (messageId: string, outputTokens: number): UsageEntry => ({
  messageId,
  model: "claude-haiku-4-5",
  inputTokens: 0,
  outputTokens,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
});

describe("FakeUsageSource", () => {
  it("returns the entries set for a session and none for another", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries("s1", [entry("m1", 10)]);

    expect(await usage.entries("s1")).toEqual([entry("m1", 10)]);
    expect(await usage.entries("s2")).toEqual([]);
  });

  it("replaces a session's entries on a later set", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries("s1", [entry("m1", 10)]);

    usage.setEntries("s1", [entry("m2", 20)]);

    expect(await usage.entries("s1")).toEqual([entry("m2", 20)]);
  });

  it("answers queued reads in order, then the set entries", async () => {
    const usage = new FakeUsageSource();
    usage.setEntries("s1", [entry("m2", 20)]);
    usage.queueReads("s1", [], [entry("m1", 10)]);

    expect(await usage.entries("s1")).toEqual([]);
    expect(await usage.entries("s1")).toEqual([entry("m1", 10)]);
    expect(await usage.entries("s1")).toEqual([entry("m2", 20)]);
    expect(await usage.entries("s2")).toEqual([]);
  });

  it("records the session of each read", async () => {
    const usage = new FakeUsageSource();

    await usage.entries("s1");
    await usage.entries("s2");

    expect(usage.calls).toEqual(["s1", "s2"]);
  });
});
