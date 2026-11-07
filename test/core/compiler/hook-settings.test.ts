import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardHookFiles } from "../../../src/core/compiler/guard-hooks.js";
import {
  buildHookCommand,
  hookCommand,
  hookEnvironment,
  hookSettings,
  permissionHookTimeoutSeconds,
  shellQuote,
} from "../../../src/core/compiler/hook-settings.js";
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

  it("registers the force-push guard on Bash and the rules hook after compaction, and nothing else", () => {
    const { hooks } = settings() as unknown as { hooks: Record<string, GuardEntry[]> };

    expect(Object.keys(hooks).sort()).toEqual([
      "PermissionRequest",
      "PostToolUse",
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
