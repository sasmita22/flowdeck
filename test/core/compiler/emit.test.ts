import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyReport } from "../../../src/core/compiler/build-report.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { guardHookFiles } from "../../../src/core/compiler/guard-hooks.js";
import { handoffTemplates } from "../../../src/core/compiler/handoff-templates.js";
import { buildHookCommand, hookSettings } from "../../../src/core/compiler/hook-settings.js";
import { lower } from "../../../src/core/compiler/lower.js";
import { orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";
import { agent, fileWire, flow, thenWire } from "../../fixtures/flow-builders.js";
import { expectBareHandoffRule, nestedHandoffPaths } from "../../fixtures/handoff.js";

const sample = () => {
  const base = flow(
    [agent("p"), agent("a", { settings: { tools: ["Grep"] } })],
    [thenWire("p", "a"), fileWire("p", "a", "plan.md")],
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
  workspace: "/fd-home/workspaces/b-login",
};

const fixSignup = {
  name: "fix-signup",
  values: { ticket: "FD-12", "proceed-e2e": false },
  blueprint: { name: "Review", version: 1 },
  repo: "/work/flowdeck",
  base: "main",
  workspace: "/fd-home/workspaces/b-signup",
};

const lowered = (build = fixLogin) =>
  lower(sample(), {
    name: build.name,
    values: build.values,
    repo: build.repo,
    workspace: build.workspace,
  });

const emitted = (build = fixLogin) =>
  emit(lowered(build), {
    blueprint: build.blueprint,
    repo: build.repo,
    base: build.base,
    workspace: build.workspace,
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
  it("lays down the whole plugin under plugin/ and the settings, CLAUDE.md, report and manifest at the root, sorted by path", () => {
    expect(emitted().map((file) => file.path)).toEqual([
      "CLAUDE.md",
      "build-report.json",
      "manifest.json",
      "plugin/.claude-plugin/plugin.json",
      "plugin/agents/a.md",
      "plugin/agents/p.md",
      "plugin/hooks/hooks.json",
      "plugin/hooks/no-force-push.sh",
      "plugin/hooks/rules-after-compact.sh",
      "plugin/skills/run/SKILL.md",
      "plugin/templates/plan.md",
      "settings.json",
    ]);
  });

  it("writes nothing under plugin/commands/ or plugin/scripts/", () => {
    expect(emitted().filter((file) => /^plugin\/(commands|scripts)\//.test(file.path))).toEqual([]);
  });

  it("writes the agent files that lowering compiled", () => {
    const files = emitted();

    for (const file of lowered().nodeFiles) {
      expect(fileAt(files, file.path)).toBe(file.content);
    }
    expect(lowered().nodeFiles.map((file) => file.path)).toEqual([
      "plugin/agents/p.md",
      "plugin/agents/a.md",
    ]);
  });

  it("writes one hand-off template per File-wire file", () => {
    const files = emitted();

    for (const template of handoffTemplates(sample(), "carousell-web")) {
      expect(fileAt(files, template.path)).toBe(template.content);
    }
  });

  it("names no hand-off file of the flow under the repo folder in any emitted file", () => {
    const nested = emitted().flatMap((file) =>
      nestedHandoffPaths(file.content, "carousell-web", ["plan.md"]).map(
        (path) => `${file.path}: ${path}`,
      ),
    );

    expect(nested).toEqual([]);
  });

  it("writes the orchestrator from the lowered manifest, scoped to this build, repo folder and workspace", () => {
    const expected = orchestratorSkill(lowered().manifest, {
      build: "fix-login",
      repo: "carousell-web",
      workspace: "/fd-home/workspaces/b-login",
    });

    expect(fileAt(emitted(), expected.path)).toBe(expected.content);
  });

  it("writes both guard hook scripts", () => {
    const files = emitted();

    for (const script of guardHookFiles()) {
      expect(fileAt(files, script.path)).toBe(script.content);
    }
  });

  it("writes build-report.json as the empty report", () => {
    expect(JSON.parse(fileAt(emitted(), "build-report.json"))).toStrictEqual(emptyReport());
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

    expect(settings.permissions).toStrictEqual({
      allow: ["Read", "Edit"],
      defaultMode: "acceptEdits",
    });
  });

  it("turns background tasks off for every session started on the workspace settings, as run sessions do", () => {
    const settings = JSON.parse(fileAt(emitted(), "settings.json"));

    expect(settings).toStrictEqual({
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      permissions: { allow: ["Read", "Edit"], defaultMode: "acceptEdits" },
    });
  });

  it("writes hook settings that run the hook the session's environment names", () => {
    const hooks = fileAt(emitted(), "plugin/hooks/hooks.json");

    expect(hooks).toBe(canonicalJson(hookSettings(buildHookCommand)));
    expect(hooks.replaceAll("${CLAUDE_PLUGIN_ROOT}/hooks/", "")).not.toContain("/");
  });

  it("writes the lowered manifest with a sha256 per emitted file but the report, as canonical JSON, without a hash", () => {
    const manifestBefore = lowered().manifest;
    const files = emitted();
    const manifest = fileAt(files, "manifest.json");
    const expectedFiles = Object.fromEntries(
      files
        .filter((file) => file.path !== "manifest.json" && file.path !== "build-report.json")
        .map((file) => [file.path, createHash("sha256").update(file.content).digest("hex")]),
    );

    expect(manifest).toBe(canonicalJson({ ...manifestBefore, files: expectedFiles }));
    expect(Object.keys(JSON.parse(manifest).files)).toEqual(
      expect.arrayContaining(["CLAUDE.md", "plugin/.claude-plugin/plugin.json"]),
    );
    expect(JSON.parse(manifest).files).not.toHaveProperty(["build-report.json"]);
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

    it("names the target repo's absolute path as read only while building", () => {
      const { summary } = summaryOf(fileAt(emitted(), "CLAUDE.md"));

      expect(summary).toMatch(
        /^- Target repo \(read only while building\): \/Users\/dev\/code\/carousell-web$/m,
      );
    });

    it("keeps the Repository folder label and value, saying it is relative to the workspace and that run sessions start inside it", () => {
      const { summary } = summaryOf(fileAt(emitted(), "CLAUDE.md"));
      const line = summary.split("\n").find((text) => text.startsWith("- Repository folder: "));

      expect(line).toMatch(/^- Repository folder: carousell-web\b/);
      expect(line).toMatch(/relative to the workspace/i);
      expect(line).toMatch(/run sessions start inside it/i);
    });

    it("says the plugin folder is plugin/ in the workspace and run sessions reach it as ${CLAUDE_PLUGIN_ROOT}", () => {
      const { summary } = summaryOf(fileAt(emitted(), "CLAUDE.md"));
      const line = summary.split("\n").find((text) => text.startsWith("- Plugin folder: ")) ?? "";

      expect(line).toMatch(/^- Plugin folder: `?plugin\/`? in the workspace\b/);
      expect(line).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(line).toMatch(/run sessions reach it as/i);
    });

    it("says hand-off files are named bare in the run's working folder, which sits at the repo folder in the workspace, never the workspace itself", () => {
      const { summary } = summaryOf(fileAt(emitted(), "CLAUDE.md"));

      expectBareHandoffRule(summary, "carousell-web");
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
