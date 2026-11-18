import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { runChoices, storedAuto, storedOptions } from "../../../src/core/run/options.js";
import { agent, flow, gate } from "../../fixtures/flow-builders.js";

const manifestOf = (nodes: unknown[]) =>
  lower(flow(nodes, []), { name: "fix-login", values: {} }).manifest;

describe("runChoices", () => {
  it("offers only automatic mode for a build with a skippable gate", () => {
    const manifest = manifestOf([
      gate("g", { settings: { shown: "Check", skippable: true } }),
      agent("p"),
    ]);

    expect(runChoices(manifest)).toEqual({ automatic: true });
  });

  it("offers nothing for a build without a skippable gate", () => {
    const manifest = manifestOf([agent("s"), gate("g"), agent("p")]);

    expect(runChoices(manifest)).toEqual({ automatic: false });
  });
});

describe("stored run options", () => {
  it("keeps automatic mode in the stored record", () => {
    expect(storedOptions({ inputs: {}, flags: {}, auto: true })).toEqual({ auto: true });
    expect(storedOptions({ inputs: {}, flags: {}, auto: false })).toEqual({});
  });

  it("reads back automatic mode for a resume", () => {
    expect(storedAuto({ ticket: "FD-1", deep: false, auto: true })).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});
