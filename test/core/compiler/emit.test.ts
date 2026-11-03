import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { buildHookCommand, hookSettings } from "../../../src/core/compiler/hook-settings.js";
import { lower } from "../../../src/core/compiler/lower.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

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

const fixLogin = {
  name: "fix-login",
  values: { ticket: "FD-99" },
  blueprint: { name: "Bugfix", version: 3 },
  repo: "/Users/dev/code/carousell-web",
  base: "release/2026-11",
};

const fixSignup = {
  name: "fix-signup",
  values: { ticket: "FD-12", "proceed-e2e": false },
  blueprint: { name: "Review", version: 1 },
  repo: "/work/flowdeck",
  base: "main",
};

const emitted = (build = fixLogin) =>
  emit(lower(sample(), { name: build.name, values: build.values }), {
    blueprint: build.blueprint,
    repo: build.repo,
    base: build.base,
  });

const fileAt = (files: { path: string; content: string }[], path: string) => {
  expect(files.map((file) => file.path)).toContain(path);
  return files.find((file) => file.path === path)?.content ?? "";
};

const summaryOf = (claudeMd: string) => {
  const [summary = "", ...rest] = claudeMd.split(standardRules.text);
  expect(rest).toHaveLength(1);
  return { summary, after: rest[0] ?? "" };
};

describe("emit", () => {
  it("emits the plugin under plugin/ and the settings, CLAUDE.md and manifest at the root, sorted by path", () => {
    expect(emitted().map((file) => file.path)).toEqual([
      "CLAUDE.md",
      "manifest.json",
      "plugin/.claude-plugin/plugin.json",
      "plugin/agents/a.md",
      "plugin/commands/p.md",
      "plugin/hooks/hooks.json",
      "settings.json",
    ]);
  });

  it("names the plugin after the build", () => {
    expect(JSON.parse(fileAt(emitted(), "plugin/.claude-plugin/plugin.json")).name).toBe(
      "fix-login",
    );
    expect(JSON.parse(fileAt(emitted(fixSignup), "plugin/.claude-plugin/plugin.json")).name).toBe(
      "fix-signup",
    );
  });

  it("allows only the session's tools and sets its permission mode", () => {
    const settings = JSON.parse(fileAt(emitted(), "settings.json"));

    expect(settings).toStrictEqual({
      permissions: { allow: ["Read", "Edit"], defaultMode: "acceptEdits" },
    });
  });

  it("writes hook settings that run the hook the session's environment names", () => {
    const hooks = fileAt(emitted(), "plugin/hooks/hooks.json");

    expect(hooks).toBe(canonicalJson(hookSettings(buildHookCommand)));
    expect(hooks).not.toContain("/");
  });

  it("writes the lowered manifest with a sha256 per emitted file as canonical JSON, without a hash", () => {
    const lowered = lower(sample(), { name: fixLogin.name, values: fixLogin.values });
    const files = emit(lowered, {
      blueprint: fixLogin.blueprint,
      repo: fixLogin.repo,
      base: fixLogin.base,
    });
    const manifest = fileAt(files, "manifest.json");
    const expectedFiles = Object.fromEntries(
      files
        .filter((file) => file.path !== "manifest.json")
        .map((file) => [file.path, createHash("sha256").update(file.content).digest("hex")]),
    );

    expect(manifest).toBe(canonicalJson({ ...lowered.manifest, files: expectedFiles }));
    expect(Object.keys(JSON.parse(manifest).files)).toEqual(
      expect.arrayContaining(["CLAUDE.md", "plugin/.claude-plugin/plugin.json"]),
    );
    expect(JSON.parse(manifest)).not.toHaveProperty("hash");
  });

  describe("CLAUDE.md", () => {
    it("opens with a summary naming the build, its blueprint and version, the repo folder, the base and each value", () => {
      const { summary } = summaryOf(fileAt(emitted(), "CLAUDE.md"));

      expect(summary).toContain("fix-login");
      expect(summary).toMatch(/Bugfix.*\b3\b/);
      expect(summary).toContain("carousell-web");
      expect(summary).toContain("release/2026-11");
      expect(summary).toMatch(/ticket.*FD-99/);
    });

    it("ends with the standard rules, after a blank line", () => {
      const { summary, after } = summaryOf(fileAt(emitted(), "CLAUDE.md"));

      expect(summary).toMatch(/\S\n\n$/);
      expect(after).toBe("");
    });

    it("carries the standard rules exactly once in every build, whatever its name, blueprint, values and repo", () => {
      const login = summaryOf(fileAt(emitted(fixLogin), "CLAUDE.md"));
      const signup = summaryOf(fileAt(emitted(fixSignup), "CLAUDE.md"));

      expect(signup.summary).toContain("fix-signup");
      expect(signup.summary).toContain("flowdeck");
      expect(signup.summary).not.toBe(login.summary);
      expect(signup.after).toBe("");
    });
  });
});
