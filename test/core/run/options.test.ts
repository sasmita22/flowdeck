import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import {
  optionsClash,
  runChoices,
  storedAuto,
  storedFlags,
  storedOptions,
} from "../../../src/core/run/options.js";
import { branch, flow, gate, prompt, script, trigger } from "../../fixtures/flow-builders.js";

const manifestOf = (nodes: unknown[]) => lower(flow(nodes, [])).manifest;

describe("runChoices", () => {
  it("offers the Trigger's inputs and boolean flags with their defaults, and automatic mode for a skippable gate", () => {
    const manifest = manifestOf([
      trigger("t", { settings: { inputs: ["ticket"], flags: { deep: true, fast: false, n: 3 } } }),
      gate("g", { settings: { shown: "Check", skippable: true } }),
    ]);

    expect(runChoices(manifest)).toEqual({
      inputs: ["ticket"],
      flags: { deep: true, fast: false },
      automatic: true,
    });
  });

  it("offers nothing for a build without a Trigger's inputs or flags and without a skippable gate", () => {
    const manifest = manifestOf([script("s"), gate("g"), prompt("p")]);

    expect(runChoices(manifest)).toEqual({ inputs: [], flags: {}, automatic: false });
  });
});

describe("stored run options", () => {
  const manifest = manifestOf([
    trigger("t", { settings: { inputs: [], flags: { deep: true } } }),
    branch("b", "deep"),
    script("yes"),
    script("no"),
  ]);

  it("keeps inputs, flags and automatic mode in one record, the way the CLI stores them", () => {
    expect(
      storedOptions({ inputs: { ticket: "FD-1" }, flags: { deep: false }, auto: true }),
    ).toEqual({ ticket: "FD-1", deep: false, auto: true });
    expect(storedOptions({ inputs: {}, flags: {}, auto: false })).toEqual({});
  });

  it("reads back only the build's boolean flags, and automatic mode", () => {
    const stored = { ticket: "FD-1", deep: false, other: true, auto: true };

    expect(storedFlags(stored, manifest)).toEqual({ deep: false });
    expect(storedAuto(stored)).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});

describe("optionsClash", () => {
  const triggerWith = (inputs: string[], flags: Record<string, boolean>) =>
    manifestOf([trigger("t", { settings: { inputs, flags } }), script("s")]);

  it("refuses a Trigger flag named auto, the way the CLI does", () => {
    expect(optionsClash(triggerWith([], { auto: true }))).toBe(
      'Trigger flag "auto" clashes with the built-in option --auto',
    );
  });

  it("refuses a Trigger input named auto", () => {
    expect(optionsClash(triggerWith(["auto"], {}))).toBe(
      'Trigger input "auto" clashes with the built-in option --auto',
    );
  });

  it("refuses a Trigger input or flag named model, which a resume reads as the model", () => {
    expect(optionsClash(triggerWith(["model"], {}))).toBe(
      'Trigger input "model" clashes with the built-in option --model',
    );
    expect(optionsClash(triggerWith([], { model: true }))).toBe(
      'Trigger flag "model" clashes with the built-in option --model',
    );
  });

  it("refuses a Trigger input and flag with the same name", () => {
    expect(optionsClash(triggerWith(["deep"], { deep: true }))).toBe(
      'Trigger input "deep" clashes with the Trigger flag "deep"',
    );
  });

  it("accepts distinct names", () => {
    expect(optionsClash(triggerWith(["ticket"], { deep: true }))).toBeUndefined();
  });
});
