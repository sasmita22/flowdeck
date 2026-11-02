import { describe, expect, it } from "vitest";
import {
  agentModelChoices,
  modelChoices,
  permissionModes,
} from "../../../src/core/flow/choices.js";
import { contextWindows } from "../../../src/core/run/context.js";

const values = (choices: readonly { value: string }[]) => choices.map(({ value }) => value);

describe("modelChoices", () => {
  it("offers Claude Code's model aliases first, then every full id the context table knows", () => {
    expect(values(modelChoices)).toEqual([
      "sonnet",
      "opus",
      "haiku",
      ...Object.keys(contextWindows),
    ]);
  });

  it("names the aliases in plain words and shows full ids as they are", () => {
    expect(modelChoices.slice(0, 3).map(({ label }) => label)).toEqual([
      "Sonnet (latest)",
      "Opus (latest)",
      "Haiku (latest)",
    ]);
    expect(modelChoices.find(({ value }) => value === "claude-haiku-4-5")?.label).toBe(
      "claude-haiku-4-5",
    );
  });
});

describe("agentModelChoices", () => {
  it("starts with the session's own model, saved as empty, then the same list", () => {
    expect(agentModelChoices[0]).toEqual({ value: "", label: "Same as the session" });
    expect(agentModelChoices.slice(1)).toEqual(modelChoices);
  });
});

describe("permissionModes", () => {
  it("offers Claude Code's permission modes in plain words", () => {
    expect(permissionModes).toEqual([
      { value: "default", label: "Ask before risky actions" },
      { value: "acceptEdits", label: "Accept file edits without asking" },
      { value: "plan", label: "Plan only, change nothing" },
      { value: "bypassPermissions", label: "Never ask (skip all checks)" },
    ]);
  });
});
