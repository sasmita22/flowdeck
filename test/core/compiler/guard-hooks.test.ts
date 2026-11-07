import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardHookFiles } from "../../../src/core/compiler/guard-hooks.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";

const folder = mkdtempSync(join(tmpdir(), "fd guard "));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const written = (() => {
  for (const file of guardHookFiles()) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return (path: string) => join(folder, path);
})();

const run = (script: string, input: unknown) =>
  spawnSync("bash", [written(script)], { input: JSON.stringify(input), encoding: "utf8" });

const bashCall = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

describe("guardHookFiles", () => {
  it("writes the force-push guard and the compaction rules hook under plugin/hooks", () => {
    expect(guardHookFiles().map((file) => file.path)).toEqual([
      "plugin/hooks/no-force-push.sh",
      "plugin/hooks/rules-after-compact.sh",
    ]);
  });

  it.each(["git push --force", "git push -f origin x", "git push --force-with-lease origin x"])(
    "denies %s",
    (command) => {
      const result = run("plugin/hooks/no-force-push.sh", bashCall(command));

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout || "{}")).toMatchObject({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
    },
  );

  it.each(["git push origin x", "ls", "git fetch --force"])("lets %s through", (command) => {
    const result = run("plugin/hooks/no-force-push.sh", bashCall(command));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("prints the workspace's flow rules after a compaction", () => {
    const result = run("plugin/hooks/rules-after-compact.sh", {
      hook_event_name: "SessionStart",
      source: "compact",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(standardRules.text);
  });
});
