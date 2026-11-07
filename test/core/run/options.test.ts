import { describe, expect, it } from "vitest";
import { lower, type ManifestNode } from "../../../src/core/compiler/lower.js";
import {
  optionsClash,
  runChoices,
  storedAuto,
  storedFlags,
  storedOptions,
} from "../../../src/core/run/options.js";
import { flow, gate, prompt, script } from "../../fixtures/flow-builders.js";

const manifestOf = (nodes: unknown[]) =>
  lower(flow(nodes, []), { name: "fix-login", values: {} }).manifest;

const oldTrigger = (inputs: string[], flags: Record<string, unknown>): ManifestNode => ({
  id: "t",
  type: "trigger",
  label: "t",
  settings: { inputs, flags } as unknown as ManifestNode["settings"],
});

const oldScript = (id: string): ManifestNode => ({
  id,
  type: "script",
  label: id,
  settings: { command: "npm" } as ManifestNode["settings"],
});

const oldManifest = (nodes: ManifestNode[], inputs: string[] = []) => ({ nodes, inputs });

describe("runChoices", () => {
  it("offers only automatic mode for a build with a skippable gate", () => {
    const manifest = manifestOf([
      gate("g", { settings: { shown: "Check", skippable: true } }),
      prompt("p"),
    ]);

    expect(runChoices(manifest)).toEqual({ automatic: true });
  });

  it("offers nothing for a build without a skippable gate", () => {
    const manifest = manifestOf([script("s"), gate("g"), prompt("p")]);

    expect(runChoices(manifest)).toEqual({ automatic: false });
  });
});

describe("stored run options", () => {
  it("keeps automatic mode in the stored record", () => {
    expect(storedOptions({ inputs: {}, flags: {}, auto: true })).toEqual({ auto: true });
    expect(storedOptions({ inputs: {}, flags: {}, auto: false })).toEqual({});
  });

  it("reads back an old build's boolean Trigger flags, and automatic mode, for a resume", () => {
    const manifest = oldManifest([oldTrigger([], { deep: true }), oldScript("s")]);
    const stored = { ticket: "FD-1", deep: false, other: true, auto: true };

    expect(storedFlags(stored, manifest)).toEqual({ deep: false });
    expect(storedAuto(stored)).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});

describe("optionsClash on an old build", () => {
  const triggerWith = (inputs: string[], flags: Record<string, boolean>) =>
    oldManifest([oldTrigger(inputs, flags), oldScript("s")], inputs);

  it("refuses a Trigger flag named auto, which a run reads as the auto option", () => {
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
