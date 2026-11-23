import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guardHookFiles } from "../../../src/core/compiler/guard-hooks.js";
import {
  buildHookCommand,
  containerStartCommand,
  hookCommand,
  hookEnvironment,
  hookSettings,
  PARENT_SESSION_VARS,
  permissionHookTimeoutSeconds,
  sessionEnvNames,
  shellQuote,
} from "../../../src/core/compiler/hook-settings.js";
import type { ManifestContainer } from "../../../src/core/compiler/lower.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";

describe("shellQuote", () => {
  it.each([
    ["/a b/node", "'/a b/node'"],
    ["it's", "'it'\\''s'"],
    ["/plain", "'/plain'"],
  ])("quotes %s as %s", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});

type GuardEntry = { matcher?: string; hooks: { type: string; command: string }[] };

const guardOn = (entries: readonly GuardEntry[], matcher: string) => {
  const matching = entries.filter((entry) => entry.matcher === matcher);
  expect(matching).toHaveLength(1);
  expect(matching[0]?.hooks).toHaveLength(1);
  return matching[0]?.hooks[0]?.command ?? "";
};

describe("hookSettings", () => {
  const command = "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-hook.ts'";
  const settings = () =>
    hookSettings(
      hookCommand({
        nodePath: "/Users/x/my node/bin/node",
        hookScriptPath: "/Users/x/flow deck/bin/flowdeck-hook.ts",
      }),
    );

  it("waits a day for a permission answer", () => {
    expect(permissionHookTimeoutSeconds).toBe(86_400);
  });

  it("adds one fire-and-forget hook per event kind and a timed permission hook, unchanged", () => {
    const entry = [{ hooks: [{ type: "command", command }] }];
    const { hooks } = settings();

    expect(hooks.Stop).toStrictEqual(entry);
    expect(hooks.PreToolUse[0]).toStrictEqual(entry[0]);
    expect(hooks.PostToolUse).toStrictEqual(entry);
    expect(hooks.SubagentStop).toStrictEqual(entry);
    expect(hooks.StopFailure).toStrictEqual(entry);
    expect(hooks.PermissionRequest).toStrictEqual([
      {
        hooks: [
          {
            type: "command",
            command: `${command} --permission-deadline-ms=86340000`,
            timeout: 86_400,
          },
        ],
      },
    ]);
  });

  it("routes a failed tool call to the hook script exactly as a finished one", () => {
    const { hooks } = settings() as unknown as { hooks: Record<string, GuardEntry[]> };

    expect(hooks.PostToolUseFailure).toStrictEqual(hooks.PostToolUse);
  });

  it("registers the force-push guard on Bash and the rules hook after compaction, and nothing else", () => {
    const { hooks } = settings() as unknown as { hooks: Record<string, GuardEntry[]> };

    expect(Object.keys(hooks).sort()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "StopFailure",
      "SubagentStop",
    ]);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(guardOn(hooks.PreToolUse ?? [], "Bash")).toContain(
      "${CLAUDE_PLUGIN_ROOT}/hooks/no-force-push.sh",
    );
    expect(hooks.SessionStart).toHaveLength(1);
    expect(guardOn(hooks.SessionStart ?? [], "compact")).toContain(
      "${CLAUDE_PLUGIN_ROOT}/hooks/rules-after-compact.sh",
    );
  });

  describe("guard commands, run from a plugin folder as the build writes it", () => {
    const pluginRoot = () => {
      const folder = mkdtempSync(join(tmpdir(), "fd plugin "));
      for (const file of guardHookFiles()) {
        const path = join(folder, file.path.replace(/^plugin\//, ""));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      return folder;
    };

    const runGuard = (event: string, matcher: string, input: unknown) => {
      const { hooks } = settings() as unknown as { hooks: Record<string, GuardEntry[]> };
      const folder = pluginRoot();
      try {
        return spawnSync("/bin/sh", ["-c", guardOn(hooks[event] ?? [], matcher)], {
          env: { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_ROOT: folder },
          input: JSON.stringify(input),
          encoding: "utf8",
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    };

    it("denies a force push", () => {
      const result = runGuard("PreToolUse", "Bash", {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push --force" },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    });

    it("prints the flow rules after compaction", () => {
      const result = runGuard("SessionStart", "compact", {
        hook_event_name: "SessionStart",
        source: "compact",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(standardRules.text);
    });
  });

  it("ends the hook's own deadline a minute before Claude Code's timeout", () => {
    expect(settings().hooks.PermissionRequest[0]?.hooks).toStrictEqual([
      {
        type: "command",
        command: `${command} --permission-deadline-ms=${(permissionHookTimeoutSeconds - 60) * 1000}`,
        timeout: permissionHookTimeoutSeconds,
      },
    ]);
  });
});

describe("the build's hook command", () => {
  it("names no machine path", () => {
    expect(buildHookCommand).not.toMatch(/\//);
  });

  it("runs the node and hook script that the session's environment names, spaces and all", () => {
    const folder = mkdtempSync(join(tmpdir(), "fd hook "));
    try {
      const script = join(folder, "my hook.cjs");
      writeFileSync(script, "process.stdout.write('hook ran ' + process.argv.slice(2).join(' '))");

      const output = execFileSync("/bin/sh", ["-c", `${buildHookCommand} --flag`], {
        env: {
          PATH: "",
          ...hookEnvironment({ nodePath: process.execPath, hookScriptPath: script }),
        },
        encoding: "utf8",
      });

      expect(output).toBe("hook ran --flag");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  const quietly = (env: Record<string, string>) =>
    spawnSync("/bin/sh", ["-c", `${buildHookCommand} --flag`], {
      env: { PATH: "", ...env },
      input: JSON.stringify({ hook_event_name: "Stop" }),
      encoding: "utf8",
    });

  it("exits 0 and prints nothing when the session's environment names no node and no hook script", () => {
    const result = quietly({});

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["only the node", { FLOWDECK_HOOK_NODE: process.execPath }],
    ["only the hook script", { FLOWDECK_HOOK_SCRIPT: "/nowhere/flowdeck-hook.cjs" }],
  ])("exits 0 and prints nothing when the environment names %s", (_, env) => {
    const result = quietly(env);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

const manifestContainer = (kind: ManifestContainer["kind"], slug: string): ManifestContainer => ({
  kind,
  name: slug,
  slug,
  prefix: `fix-login-${slug}`,
  model: "sonnet",
  nodes: [],
  wires: [],
  orchestrator: `sessions/${slug}/plugin/skills/run/SKILL.md`,
});

describe("sessionEnvNames", () => {
  it("names a tmux and a session id variable for each session container, and none for the workspace", () => {
    expect(
      sessionEnvNames([
        manifestContainer("workspace", "workspace"),
        manifestContainer("session", "android"),
      ]),
    ).toEqual(
      new Map([["android", { tmux: "FD_SESSION_ANDROID_TMUX", id: "FD_SESSION_ANDROID_ID" }]]),
    );
  });

  it("upper-cases the slug and turns each run of other characters into one underscore", () => {
    expect(sessionEnvNames([manifestContainer("session", "my-app")]).get("my-app")).toEqual({
      tmux: "FD_SESSION_MY_APP_TMUX",
      id: "FD_SESSION_MY_APP_ID",
    });
  });

  it("adds _2 to the later of two slugs that sanitise alike", () => {
    const names = sessionEnvNames([
      manifestContainer("session", "my-app"),
      manifestContainer("session", "my.app"),
    ]);

    expect(names.get("my-app")).toEqual({
      tmux: "FD_SESSION_MY_APP_TMUX",
      id: "FD_SESSION_MY_APP_ID",
    });
    expect(names.get("my.app")).toEqual({
      tmux: "FD_SESSION_MY_APP_2_TMUX",
      id: "FD_SESSION_MY_APP_2_ID",
    });
  });
});

describe("containerStartCommand", () => {
  const buildDir = "/fd home/workspaces/b-login";
  const workspaceDir = `${buildDir}/workspace`;
  const worktree = `${buildDir}/sessions/android/android`;
  const settingsPath = `${buildDir}/sessions/android/settings.json`;
  const pluginPath = `${buildDir}/sessions/android/plugin`;
  const android: ManifestContainer = {
    ...manifestContainer("session", "android"),
    repo: "/repos/android",
    base: "main",
    branch: "flowdeck/fix-login",
    worktree,
  };
  const command = () =>
    containerStartCommand({
      container: android,
      buildDir,
      workspaceDir,
      env: { tmux: "FD_SESSION_ANDROID_TMUX", id: "FD_SESSION_ANDROID_ID" },
    });

  it("starts a tmux server and session named by the container's tmux variable, in its worktree", () => {
    expect(
      command().startsWith(
        `tmux -L "$FD_SESSION_ANDROID_TMUX" new-session -d -s "$FD_SESSION_ANDROID_TMUX" -c ${shellQuote(worktree)} `,
      ),
    ).toBe(true);
  });

  it.each([
    '-e FLOWDECK_SOCK="$FLOWDECK_SOCK"',
    '-e FLOWDECK_HOOK_NODE="$FLOWDECK_HOOK_NODE"',
    '-e FLOWDECK_HOOK_SCRIPT="$FLOWDECK_HOOK_SCRIPT"',
    "-e CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
  ])("forwards %s to the session", (flag) => {
    expect(command()).toContain(` ${flag} `);
  });

  it("clears every parent session variable, then starts Claude on the container's id, model, settings and plugin, with the workspace added, running its orchestrator", () => {
    const unset = PARENT_SESSION_VARS.map((name) => `-u ${name}`).join(" ");

    expect(PARENT_SESSION_VARS).toContain("CLAUDECODE");
    expect(
      command().endsWith(
        ` env ${unset} claude --session-id "$FD_SESSION_ANDROID_ID" --model ${shellQuote("sonnet")} --settings ${shellQuote(settingsPath)} --plugin-dir ${shellQuote(pluginPath)} --add-dir ${shellQuote(workspaceDir)} ${shellQuote("/fix-login-android:run")}`,
      ),
    ).toBe(true);
  });

  it("names no build path relative to the session's folder", () => {
    expect(command()).not.toMatch(/'\.\.(\/|')/);
  });

  describe("started by real tmux on a new server", () => {
    const startWith = async (configDir: string | undefined) => {
      const root = mkdtempSync(join(tmpdir(), "fd tmux probe "));
      const bin = join(root, "bin");
      const worktreeDir = join(root, "worktree");
      const seen = join(root, "seen");
      const sockets = mkdtempSync("/tmp/fd-test-");
      mkdirSync(bin);
      mkdirSync(worktreeDir);
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\nprintf '%s' "\${CLAUDE_CONFIG_DIR-UNSET}" > ${shellQuote(seen)}\n`,
        { mode: 0o755 },
      );
      const tmuxName = `fd-test-${process.pid}-${Date.now()}`;
      const env: Record<string, string> = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        SHELL: "/bin/sh",
        TMUX_TMPDIR: sockets,
        FD_SESSION_ANDROID_TMUX: tmuxName,
        FD_SESSION_ANDROID_ID: "11111111-2222-4333-8444-555555555555",
        FLOWDECK_SOCK: join(root, "fd.sock"),
        FLOWDECK_HOOK_NODE: process.execPath,
        FLOWDECK_HOOK_SCRIPT: join(root, "hook.cjs"),
        ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
      };
      try {
        execFileSync(
          "/bin/sh",
          [
            "-c",
            containerStartCommand({
              container: { ...android, worktree: worktreeDir },
              buildDir,
              workspaceDir,
              env: { tmux: "FD_SESSION_ANDROID_TMUX", id: "FD_SESSION_ANDROID_ID" },
            }),
          ],
          { env },
        );
        await vi.waitFor(() => expect(existsSync(seen)).toBe(true), { timeout: 5000 });
        return readFileSync(seen, "utf8");
      } finally {
        spawnSync("tmux", ["-L", tmuxName, "kill-server"], { env });
        rmSync(root, { recursive: true, force: true });
        rmSync(sockets, { recursive: true, force: true });
      }
    };

    it("hands the session the starting shell's CLAUDE_CONFIG_DIR, spaces and all", async () => {
      expect(await startWith("/x y")).toBe("/x y");
    });

    it("leaves CLAUDE_CONFIG_DIR unset in the session when the starting shell has none", async () => {
      expect(await startWith(undefined)).toBe("UNSET");
    });
  });

  it("passes tmux the run's names and values and Claude its arguments intact when a shell runs it, spaces and all", () => {
    const bin = mkdtempSync(join(tmpdir(), "fd tmux "));
    try {
      writeFileSync(
        join(bin, "tmux"),
        '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done\n',
        {
          mode: 0o755,
        },
      );
      const env = {
        PATH: bin,
        FD_SESSION_ANDROID_TMUX: "fd-run-0a1b2c3d",
        FD_SESSION_ANDROID_ID: "11111111-2222-4333-8444-555555555555",
        FLOWDECK_SOCK: "/fd home/sockets/fd-run-9f8e7d6c.sock",
        FLOWDECK_HOOK_NODE: "/my node/bin/node",
        FLOWDECK_HOOK_SCRIPT: "/flow deck/bin/flowdeck-hook.cjs",
        CLAUDE_CONFIG_DIR: "/fd home/claude config",
      };

      const argv = execFileSync("/bin/sh", ["-c", command()], { env, encoding: "utf8" })
        .split("\n")
        .slice(0, -1);

      const head = [
        "-L",
        "fd-run-0a1b2c3d",
        "new-session",
        "-d",
        "-s",
        "fd-run-0a1b2c3d",
        "-c",
        worktree,
      ];
      const tail = [
        "env",
        ...PARENT_SESSION_VARS.flatMap((name) => ["-u", name]),
        "claude",
        "--session-id",
        env.FD_SESSION_ANDROID_ID,
        "--model",
        "sonnet",
        "--settings",
        settingsPath,
        "--plugin-dir",
        pluginPath,
        "--add-dir",
        workspaceDir,
        "/fix-login-android:run",
      ];
      const forwarded = [
        `FLOWDECK_SOCK=${env.FLOWDECK_SOCK}`,
        `FLOWDECK_HOOK_NODE=${env.FLOWDECK_HOOK_NODE}`,
        `FLOWDECK_HOOK_SCRIPT=${env.FLOWDECK_HOOK_SCRIPT}`,
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
      ];
      const middle = argv.slice(head.length, argv.length - tail.length);

      expect(argv.slice(0, head.length)).toEqual(head);
      expect(argv.slice(argv.length - tail.length)).toEqual(tail);
      expect(middle.filter((_, i) => i % 2 === 0)).toEqual(forwarded.map(() => "-e"));
      expect(middle.filter((_, i) => i % 2 === 1).sort()).toEqual([...forwarded].sort());
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
