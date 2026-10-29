import { describe, expect, it } from "vitest";
import { validate } from "../../../../src/core/compiler/validate.js";
import { defaultLabel, defaultSettings } from "../../../../src/core/nodes/script/defaults.js";
import { settings } from "../../../../src/core/nodes/script/settings.js";
import { flow } from "../../../fixtures/flow-builders.js";

describe("script defaults", () => {
  it("starts with empty command and the label Script", () => {
    expect(defaultSettings).toEqual({ command: "" });
    expect(defaultLabel).toBe("Script");
  });

  it("satisfies the script settings schema unchanged", () => {
    expect(settings.parse(defaultSettings)).toEqual(defaultSettings);
  });

  it("makes a node that parses in a flow and passes validation", () => {
    const node = {
      id: "script-1",
      type: "script",
      label: defaultLabel,
      position: { x: 0, y: 0 },
      settings: defaultSettings,
    };

    expect(validate(flow([node], []))).toEqual([]);
  });
});
