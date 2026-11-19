import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { layDown } from "../../../src/core/compiler/build.js";
import { emptyReport } from "../../../src/core/compiler/build-report.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit, workspaceClaudeMd } from "../../../src/core/compiler/emit.js";
import { guardHookFiles } from "../../../src/core/compiler/guard-hooks.js";
import { handoffTemplates } from "../../../src/core/compiler/handoff-templates.js";
import { buildHookCommand, hookSettings } from "../../../src/core/compiler/hook-settings.js";
import { lower } from "../../../src/core/compiler/lower.js";
import { orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";
import { newCanvasFlow } from "../../../src/app/renderer/canvas/store.js";
import {
  agent,
  flow,
  flowSettings,
  sessionsWorkflow,
  thenWire,
  twoSessionWorkflow,
} from "../../fixtures/flow-builders.js";
import { expectBareHandoffRule, nestedHandoffPaths } from "../../fixtures/handoff.js";

const sample = (
  permissionMode = "acceptEdits",
  session = { repo: "/Users/dev/code/carousell-web", branch: "release/2026-11" },
) =>
  flow(
    [
      agent("p", { settings: { writes: ["plan.md"] } }),
      agent("a", { settings: { given: ["plan.md"] } }),
    ],
    [thenWire("p", "a")],
    { ...flowSettings, permissionMode },
    { session },
  );

const root = "sessions/main";
const inRoot = (path: string) => `${root}/${path}`;

const fixLogin = {
  name: "fix-login",
  values: { ticket: "FD-99" },
  blueprint: { name: "Bugfix", version: 3 },
  repo: "/Users/dev/code/carousell-web",
  base: "release/2026-11",
  branch: "flowdeck/fix-login",
  branchCreated: true,
  workspace: "/fd-home/workspaces/b-login",
};

const fixSignup = {
  name: "fix-signup",
  values: { ticket: "FD-12", "proceed-e2e": false },
  blueprint: { name: "Review", version: 1 },
  repo: "/work/flowdeck",
  base: "main",
  branch: "flowdeck/fix-signup",
  branchCreated: true,
  workspace: "/fd-home/workspaces/b-signup",
};

const lowered = (build = fixLogin) =>
  lower(sample(undefined, { repo: build.repo, branch: build.base }), {
    name: build.name,
    values: build.values,
    workspace: build.workspace,
  });

const loginDeny = [
  "Edit(//fd-home/workspaces/b-login/workspace/**)",
  "Write(//fd-home/workspaces/b-login/workspace/**)",
];

const emitted = (build = fixLogin) =>
  emit(lowered(build), {
    blueprint: build.blueprint,
    repo: build.repo,
    base: build.base,
    branch: build.branch,
    branchCreated: build.branchCreated,
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
  it("lays down each container's plugin, settings and CLAUDE.md under its folder, and the report and manifest at the root, sorted by path", () => {
    expect(emitted().map((file) => file.path)).toEqual([
      "build-report.json",
      "manifest.json",
      "sessions/main/CLAUDE.md",
      "sessions/main/plugin/.claude-plugin/plugin.json",
      "sessions/main/plugin/agents/a.md",
      "sessions/main/plugin/agents/p.md",
      "sessions/main/plugin/hooks/hooks.json",
      "sessions/main/plugin/hooks/no-force-push.sh",
      "sessions/main/plugin/hooks/rules-after-compact.sh",
      "sessions/main/plugin/skills/run/SKILL.md",
      "sessions/main/plugin/templates/plan.md",
      "sessions/main/settings.json",
      "workspace/CLAUDE.md",
      "workspace/plugin/.claude-plugin/plugin.json",
      "workspace/plugin/hooks/hooks.json",
      "workspace/plugin/hooks/no-force-push.sh",
      "workspace/plugin/hooks/rules-after-compact.sh",
      "workspace/plugin/skills/run/SKILL.md",
      "workspace/settings.json",
    ]);
  });

  it("writes nothing under plugin/commands/ or plugin/scripts/", () => {
    expect(
      emitted().filter((file) => /(^|\/)plugin\/(commands|scripts)\//.test(file.path)),
    ).toEqual([]);
  });

  it("writes the agent files that lowering compiled", () => {
    const files = emitted();

    for (const file of lowered().nodeFiles) {
      expect(fileAt(files, file.path)).toBe(file.content);
    }
    expect(lowered().nodeFiles.map((file) => file.path)).toEqual([
      inRoot("plugin/agents/p.md"),
      inRoot("plugin/agents/a.md"),
    ]);
  });

  it("writes one hand-off template per hand-off file", () => {
    const files = emitted();
    const templates = handoffTemplates(sample(), "carousell-web");

    expect(templates.map((template) => template.path)).toEqual(["plugin/templates/plan.md"]);
    for (const template of templates) {
      expect(fileAt(files, inRoot(template.path))).toBe(template.content);
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
    const session = lowered().manifest.containers.find((container) => container.slug === "main");
    expect(session).toBeDefined();
    if (session === undefined) return;
    const expected = orchestratorSkill(session, {
      build: "fix-login-main",
      repo: "carousell-web",
      workspace: "/fd-home/workspaces/b-login",
    });

    expect(fileAt(emitted(), expected.path)).toBe(expected.content);
  });

  it("writes both guard hook scripts", () => {
    const files = emitted();

    for (const script of guardHookFiles()) {
      expect(fileAt(files, inRoot(script.path))).toBe(script.content);
      expect(fileAt(files, `workspace/${script.path}`)).toBe(script.content);
    }
  });

  it("writes build-report.json as the empty report", () => {
    expect(JSON.parse(fileAt(emitted(), "build-report.json"))).toStrictEqual(emptyReport());
  });

  it("names the plugin after the build and its container", () => {
    const plugin = inRoot("plugin/.claude-plugin/plugin.json");

    expect(JSON.parse(fileAt(emitted(), plugin)).name).toBe("fix-login-main");
    expect(JSON.parse(fileAt(emitted(fixSignup), plugin)).name).toBe("fix-signup-main");
  });

  it("sets the blueprint's permission mode, turns on the project's MCP servers and allows no tool list", () => {
    const settings = JSON.parse(fileAt(emitted(), inRoot("settings.json")));

    expect(settings.permissions).toStrictEqual({ defaultMode: "acceptEdits", deny: loginDeny });
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  it("turns background tasks off for every session started on the workspace settings, as run sessions do", () => {
    const settings = JSON.parse(fileAt(emitted(), inRoot("settings.json")));

    expect(settings).toStrictEqual({
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      permissions: { defaultMode: "acceptEdits", deny: loginDeny },
      enableAllProjectMcpServers: true,
    });
  });

  describe("permission mode", () => {
    const settingsFor = (permissionMode: string) =>
      JSON.parse(
        fileAt(
          emit(lower(sample(permissionMode), { name: "fix-login", values: {} }), {
            repo: fixLogin.repo,
            base: fixLogin.base,
            branch: fixLogin.branch,
            branchCreated: true,
            workspace: fixLogin.workspace,
          }),
          inRoot("settings.json"),
        ),
      );

    it.each(["default", "acceptEdits", "plan", "bypassPermissions"])(
      "sets defaultMode to the blueprint's %s and lists no allowed tools",
      (permissionMode) => {
        const { permissions } = settingsFor(permissionMode);

        expect(permissions).toStrictEqual({ defaultMode: permissionMode, deny: loginDeny });
        expect(permissions).not.toHaveProperty("allow");
      },
    );

    it("gives a new blueprint the never-ask mode and its consent, in the session's own settings", () => {
      const settings = settingsFor(newCanvasFlow().settings.permissionMode);

      expect(settings.permissions.defaultMode).toBe("bypassPermissions");
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    });

    it("consents for a blueprint set to never ask", () => {
      expect(settingsFor("bypassPermissions")).toStrictEqual({
        env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
        permissions: { defaultMode: "bypassPermissions", deny: loginDeny },
        enableAllProjectMcpServers: true,
        skipDangerousModePermissionPrompt: true,
      });
    });

    it.each(["default", "acceptEdits", "plan"])(
      "gives no consent to a blueprint in %s mode",
      (permissionMode) => {
        expect(settingsFor(permissionMode)).not.toHaveProperty("skipDangerousModePermissionPrompt");
      },
    );
  });

  it("writes hook settings that run the hook the session's environment names", () => {
    const hooks = fileAt(emitted(), inRoot("plugin/hooks/hooks.json"));

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

    const containers = manifestBefore.containers.map((container) =>
      container.kind === "session"
        ? {
            ...container,
            branch: fixLogin.branch,
            worktree: `${fixLogin.workspace}/sessions/main/carousell-web`,
          }
        : container,
    );

    expect(manifest).toBe(canonicalJson({ ...manifestBefore, containers, files: expectedFiles }));
    expect(Object.keys(JSON.parse(manifest).files)).toEqual(
      expect.arrayContaining([inRoot("CLAUDE.md"), inRoot("plugin/.claude-plugin/plugin.json")]),
    );
    expect(JSON.parse(manifest).files).not.toHaveProperty(["build-report.json"]);
    expect(JSON.parse(manifest)).not.toHaveProperty("hash");
  });

  describe("CLAUDE.md", () => {
    const branchLines = (branch: string, branchCreated: boolean) =>
      workspaceClaudeMd(
        { name: "x", values: {} },
        { repo: "/work/flowdeck", base: "main", branch, branchCreated },
      )
        .split("\n")
        .filter((line) => /branch/i.test(line) && line.startsWith("- "));

    it("names a new branch and the base it was cut from", () => {
      expect(branchLines("flowdeck/x", true)).toEqual(["- Branch: flowdeck/x (new from main)"]);
    });

    it("names an existing branch as existing", () => {
      expect(branchLines("feat-y", false)).toEqual(["- Branch: feat-y (existing)"]);
    });

    it("opens with a summary naming the build, its blueprint and version, the repo folder, the base and each value", () => {
      const { summary } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));

      expect(summary).toContain("fix-login");
      expect(summary).toMatch(/Bugfix.*\b3\b/);
      expect(summary).toContain("carousell-web");
      expect(summary).toContain("release/2026-11");
      expect(summary).toMatch(/ticket.*FD-99/);
    });

    it("names the target repo's absolute path as read only while building", () => {
      const { summary } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));

      expect(summary).toMatch(
        /^- Target repo \(read only while building\): \/Users\/dev\/code\/carousell-web$/m,
      );
    });

    it("keeps the Repository folder label and value, saying it is in the session's own folder and that run sessions start inside it", () => {
      const { summary } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));
      const line = summary.split("\n").find((text) => text.startsWith("- Repository folder: "));

      expect(line).toMatch(/^- Repository folder: carousell-web\b/);
      expect(line).toMatch(/in this session's own folder/i);
      expect(line).not.toMatch(/workspace/i);
      expect(line).toMatch(/run sessions start inside it/i);
    });

    it("says the plugin folder is plugin/ in the session's own folder and run sessions reach it as ${CLAUDE_PLUGIN_ROOT}", () => {
      const { summary } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));
      const line = summary.split("\n").find((text) => text.startsWith("- Plugin folder: ")) ?? "";

      expect(line).toMatch(/^- Plugin folder: `?plugin\/`? in this session's own folder\b/);
      expect(line).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(line).toMatch(/run sessions reach it as/i);
    });

    it("says hand-off files are named bare in the run's working folder, which sits at the repo folder in this session's own folder", () => {
      const { summary } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));

      expectBareHandoffRule(summary, "carousell-web");
    });

    it("ends with the standard rules, after a blank line", () => {
      const { summary, after } = summaryOf(fileAt(emitted(), inRoot("CLAUDE.md")));

      expect(summary).toMatch(/\S\n\n$/);
      expect(after).toBe("");
    });

    it("carries the standard rules exactly once in every build, whatever its name, blueprint, values and repo", () => {
      const login = summaryOf(fileAt(emitted(fixLogin), inRoot("CLAUDE.md")));
      const signup = summaryOf(fileAt(emitted(fixSignup), inRoot("CLAUDE.md")));

      expect(signup.summary).toContain("fix-signup");
      expect(signup.summary).toContain("flowdeck");
      expect(signup.summary).not.toBe(login.summary);
      expect(signup.after).toBe("");
    });
  });
});

describe("emit per container", () => {
  const home = "/fd-home";
  const dir = `${home}/workspaces/b-login`;

  const laidDown = async (input = twoSessionWorkflow()) => {
    const result = await layDown(input, {
      home,
      workspace: {
        id: "b-login",
        name: "fix-login",
        values: {},
        repo: "/repos/android",
        base: "main",
        branch: "flowdeck/fix-login",
        branchCreated: true,
      },
    });
    expect(result.ok).toBe(true);
    return result.ok ? result.files : [];
  };

  const json = (files: { path: string; content: string }[], path: string) =>
    JSON.parse(fileAt(files, path));

  const workspaceDeny = [
    "Edit(//fd-home/workspaces/b-login/workspace/**)",
    "Write(//fd-home/workspaces/b-login/workspace/**)",
  ];

  it("lists every container's Stop node in the manifest's outputs", async () => {
    const manifest = json(await laidDown(), "manifest.json");

    expect(manifest.outputs).toEqual([
      { node: "workspace-1-stop", name: "result", type: "text" },
      { node: "session-1-stop", name: "result", type: "text" },
      { node: "session-2-stop", name: "result", type: "text" },
    ]);
  });

  it("emits a Plan in android and a Plan in ios at different paths, in plugins with different names", async () => {
    const files = await laidDown();

    fileAt(files, "sessions/android/plugin/agents/plan.md");
    fileAt(files, "sessions/ios/plugin/agents/plan.md");
    expect(json(files, "sessions/android/plugin/.claude-plugin/plugin.json").name).toBe(
      "fix-login-android",
    );
    expect(json(files, "sessions/ios/plugin/.claude-plugin/plugin.json").name).toBe(
      "fix-login-ios",
    );
    expect(json(files, "workspace/plugin/.claude-plugin/plugin.json").name).toBe(
      "fix-login-workspace",
    );
  });

  it.each(["android", "ios"])(
    "denies the %s session Edit and Write on the workspace folder by its absolute path",
    async (slug) => {
      const settings = json(await laidDown(), `sessions/${slug}/settings.json`);

      expect(settings.permissions.deny).toEqual(expect.arrayContaining(workspaceDeny));
    },
  );

  it("denies the workspace session neither Edit nor Write on its own folder", async () => {
    const settings = json(await laidDown(), "workspace/settings.json");

    for (const rule of workspaceDeny) expect(settings.permissions.deny ?? []).not.toContain(rule);
  });

  it.each(["android", "ios"])(
    "tells the %s session the workspace is read only and changes go to the workspace session by message",
    async (slug) => {
      const lines = fileAt(await laidDown(), `sessions/${slug}/CLAUDE.md`).split("\n");

      expect(lines.some((line) => /workspace/i.test(line) && /read only/i.test(line))).toBe(true);
      expect(lines.some((line) => /workspace session/i.test(line) && /message/i.test(line))).toBe(
        true,
      );
    },
  );

  const handoffLine = (text: string) =>
    text.split("\n").find((line) => line.includes("Hand-off files")) ?? "";

  it.each(["android", "ios"])(
    "tells the %s session's agent, orchestrator and CLAUDE.md that hand-off files live in this session's own folder, never the workspace",
    async (slug) => {
      const files = await laidDown();

      for (const path of [
        `sessions/${slug}/plugin/agents/plan.md`,
        `sessions/${slug}/plugin/skills/run/SKILL.md`,
        `sessions/${slug}/CLAUDE.md`,
      ]) {
        const line = handoffLine(fileAt(files, path));
        expect(line, path).toContain(`\`${slug}/\``);
        expect(line, path).toContain("this session's own folder");
        expect(line, path).not.toMatch(/in this build's workspace/i);
        expect(line, path).not.toMatch(/never use the workspace folder itself/i);
      }
    },
  );

  it("keeps the workspace container's agent and orchestrator pointing hand-off files at the workspace folder", async () => {
    const files = await laidDown(
      sessionsWorkflow(
        [
          { name: "android", repo: "/repos/android", branch: "main" },
          { name: "ios", repo: "/repos/ios", branch: "develop" },
        ],
        { workspace: ["Review"] },
      ),
    );

    for (const path of [
      "workspace/plugin/agents/review.md",
      "workspace/plugin/skills/run/SKILL.md",
    ]) {
      const line = handoffLine(fileAt(files, path));
      expect(line, path).toContain("`workspace/`");
      expect(line, path).not.toContain("this session's own folder");
    }
  });

  it("records every container in the manifest, with no top-level session for two sessions", async () => {
    const manifest = json(await laidDown(), "manifest.json");

    expect(manifest.session).toBeUndefined();
    expect(
      manifest.containers.map(
        (container: Record<string, unknown> & { nodes: { id: string }[] }) => ({
          kind: container.kind,
          name: container.name,
          slug: container.slug,
          prefix: container.prefix,
          repo: container.repo,
          base: container.base,
          worktree: container.worktree,
          model: container.model,
          orchestrator: container.orchestrator,
          nodes: container.nodes.map((node) => node.id),
        }),
      ),
    ).toEqual([
      {
        kind: "workspace",
        name: "workspace",
        slug: "workspace",
        prefix: "fix-login-workspace",
        repo: undefined,
        base: undefined,
        worktree: undefined,
        model: "sonnet",
        orchestrator: "workspace/plugin/skills/run/SKILL.md",
        nodes: ["workspace-1-start", "workspace-1-stop"],
      },
      {
        kind: "session",
        name: "android",
        slug: "android",
        prefix: "fix-login-android",
        repo: "/repos/android",
        base: "main",
        worktree: `${dir}/sessions/android/android`,
        model: "sonnet",
        orchestrator: "sessions/android/plugin/skills/run/SKILL.md",
        nodes: ["session-1-start", "session-1-plan", "session-1-stop"],
      },
      {
        kind: "session",
        name: "ios",
        slug: "ios",
        prefix: "fix-login-ios",
        repo: "/repos/ios",
        base: "develop",
        worktree: `${dir}/sessions/ios/ios`,
        model: "haiku",
        orchestrator: "sessions/ios/plugin/skills/run/SKILL.md",
        nodes: ["session-2-start", "session-2-plan", "session-2-stop"],
      },
    ]);
  });

  it("fills the top-level session, prefix, nodes and wires from the one session container", async () => {
    const manifest = json(
      await laidDown(
        sessionsWorkflow([{ name: "android", repo: "/repos/android", branch: "main" }]),
      ),
      "manifest.json",
    );
    const android = manifest.containers.find(
      (container: { slug: string }) => container.slug === "android",
    );

    expect(manifest.session.name).toBe("android");
    expect(manifest.prefix).toBe("fix-login-android");
    expect(manifest.nodes).toEqual(android.nodes);
    expect(manifest.wires).toEqual(android.wires);
  });

  it.each([
    ["orchestrator", twoSessionWorkflow(), "workspace/plugin/skills/run/SKILL.md"],
    [
      "Agent piece",
      sessionsWorkflow([{ name: "android", repo: "/repos/android", branch: "main" }], {
        workspace: ["Plan"],
      }),
      "workspace/plugin/agents/plan.md",
    ],
  ])(
    "names the workspace folder in the workspace %s's scope line and hand-off folder",
    async (_label, input, path) => {
      const text = fileAt(await laidDown(input), path);

      expect(text).toContain("(repo workspace, build folder ");
      expect(text).toContain("that folder is `workspace/`");
      expect(text).not.toContain("(repo , workspace ");
      expect(text).not.toContain("that folder is `/`");
    },
  );
});
