import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { hookSettings } from "../../../src/core/compiler/hook-settings.js";
import { lower } from "../../../src/core/compiler/lower.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const hooks = { nodePath: "/usr/local/bin/node", hookScriptPath: "/fd/bin/flowdeck-hook.mjs" };

const sample = () => {
  const base = flow(
    [prompt("p"), agent("a", { settings: { tools: ["Grep"] } })],
    [thenWire("p", "a")],
  );
  return {
    ...base,
    session: { ...base.session, allowedTools: ["Read", "Edit"], permissionMode: "acceptEdits" },
  };
};

const fileAt = (files: { path: string; content: string }[], path: string) => {
  expect(files.map((file) => file.path)).toContain(path);
  return files.find((file) => file.path === path)?.content ?? "";
};

describe("emit", () => {
  it("emits the node files and the three build files, sorted by path", () => {
    expect(emit(lower(sample()), hooks).map((file) => file.path)).toEqual([
      "agents/a.md",
      "commands/p.md",
      "hooks/hooks.json",
      "manifest.json",
      "settings.json",
    ]);
  });

  it("allows only the session's tools and sets its permission mode", () => {
    const settings = JSON.parse(fileAt(emit(lower(sample()), hooks), "settings.json"));

    expect(settings).toStrictEqual({
      permissions: { allow: ["Read", "Edit"], defaultMode: "acceptEdits" },
    });
  });

  it("writes the hook settings for the given paths", () => {
    expect(fileAt(emit(lower(sample()), hooks), "hooks/hooks.json")).toBe(
      canonicalJson(hookSettings(hooks)),
    );
  });

  it("writes the lowered manifest with a sha256 per emitted file as canonical JSON, without a hash", () => {
    const lowered = lower(sample());
    const files = emit(lowered, hooks);
    const manifest = fileAt(files, "manifest.json");
    const expectedFiles = Object.fromEntries(
      files
        .filter((file) => file.path !== "manifest.json")
        .map((file) => [file.path, createHash("sha256").update(file.content).digest("hex")]),
    );

    expect(manifest).toBe(canonicalJson({ ...lowered.manifest, files: expectedFiles }));
    expect(JSON.parse(manifest).files).toStrictEqual(expectedFiles);
    expect(JSON.parse(manifest)).not.toHaveProperty("hash");
  });
});
