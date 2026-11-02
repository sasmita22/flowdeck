import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHookCommand,
  hookCommand,
  hookEnvironment,
  hookSettings,
  permissionHookTimeoutSeconds,
  shellQuote,
} from "../../../src/core/compiler/hook-settings.js";

describe("shellQuote", () => {
  it.each([
    ["/a b/node", "'/a b/node'"],
    ["it's", "'it'\\''s'"],
    ["/plain", "'/plain'"],
  ])("quotes %s as %s", (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted);
  });
});

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

  it("adds one fire-and-forget hook per event kind and a timed permission hook", () => {
    const entry = [{ hooks: [{ type: "command", command }] }];

    expect(settings()).toStrictEqual({
      hooks: {
        Stop: entry,
        PreToolUse: entry,
        PostToolUse: entry,
        SubagentStop: entry,
        StopFailure: entry,
        PermissionRequest: [
          {
            hooks: [
              {
                type: "command",
                command: `${command} --permission-deadline-ms=86340000`,
                timeout: 86_400,
              },
            ],
          },
        ],
      },
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
});
