import { describe, expect, it } from "vitest";
import {
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
    hookSettings({
      nodePath: "/Users/x/my node/bin/node",
      hookScriptPath: "/Users/x/flow deck/bin/flowdeck-hook.ts",
    });

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
