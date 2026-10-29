import { describe, expect, it } from "vitest";
import { validate } from "../../../../src/core/compiler/validate.js";
import { defaultLabel, defaultSettings } from "../../../../src/core/nodes/prompt/defaults.js";
import { settings } from "../../../../src/core/nodes/prompt/settings.js";
import { flow } from "../../../fixtures/flow-builders.js";

describe("prompt defaults", () => {
  it("starts with empty instructions and the label Prompt", () => {
    expect(defaultSettings).toEqual({ instructions: "" });
    expect(defaultLabel).toBe("Prompt");
  });

  it("satisfies the prompt settings schema unchanged", () => {
    expect(settings.parse(defaultSettings)).toEqual(defaultSettings);
  });

  it("makes a node that parses in a flow and passes validation", () => {
    const node = {
      id: "prompt-1",
      type: "prompt",
      label: defaultLabel,
      position: { x: 0, y: 0 },
      settings: defaultSettings,
    };

    expect(validate(flow([node], []))).toEqual([]);
  });
});
