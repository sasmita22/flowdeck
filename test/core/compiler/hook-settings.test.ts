import { describe, expect, it } from "vitest";
import { hookSettings, shellQuote } from "../../../src/core/compiler/hook-settings.js";

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
  it("adds one hook per kind that runs the hook script with node", () => {
    const entry = [
      {
        hooks: [
          {
            type: "command",
            command: "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-hook.ts'",
          },
        ],
      },
    ];

    expect(
      hookSettings({
        nodePath: "/Users/x/my node/bin/node",
        hookScriptPath: "/Users/x/flow deck/bin/flowdeck-hook.ts",
      }),
    ).toStrictEqual({
      hooks: { Stop: entry, PreToolUse: entry, PostToolUse: entry, SubagentStop: entry },
    });
  });
});
