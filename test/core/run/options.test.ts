import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { runChoices, storedAuto, storedOptions } from "../../../src/core/run/options.js";
import { agent, flow, gate } from "../../fixtures/flow-builders.js";

const manifestOf = (nodes: unknown[]) => ({
  nodes: lower(flow(nodes, []), { name: "fix-login", values: {} }).manifest.containers.flatMap(
    (container) => container.nodes,
  ),
});

describe("runChoices", () => {
  it("offers automatic mode for a build with an Always Gate", () => {
    const manifest = manifestOf([gate("g", { settings: { stopWhen: "always" } }), agent("p")]);

    expect(runChoices(manifest)).toEqual({ kind: "choices", automatic: true });
  });

  it("offers nothing for a build whose only Gates are Conditional", () => {
    const manifest = manifestOf([
      agent("s"),
      gate("g", { settings: { stopWhen: "conditional", condition: "tests fail" } }),
      agent("p"),
    ]);

    expect(runChoices(manifest)).toEqual({ kind: "choices", automatic: false });
  });

  it("offers nothing for a build with no Gate", () => {
    expect(runChoices(manifestOf([agent("s"), agent("p")]))).toEqual({
      kind: "choices",
      automatic: false,
    });
  });
});

describe("stored run options", () => {
  it("keeps automatic mode in the stored record", () => {
    expect(storedOptions({ auto: true })).toEqual({ auto: true });
    expect(storedOptions({ auto: false })).toEqual({});
  });

  it("reads back automatic mode for a resume", () => {
    expect(storedAuto({ ticket: "FD-1", deep: false, auto: true })).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});
