import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUILD_SESSION_DENIED,
  buildSessionSettings,
  newBuildSessionName,
} from "../../../src/core/compiler/build-session.js";

const guardCommand =
  "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-build-guard.ts' '/ws'";
const hookCommand = "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-hook.ts'";

const settings = () => buildSessionSettings({ guardCommand, hookCommand });

type Entry = { matcher?: string; hooks: { type: string; command: string }[] };

const commandsOf = (entries: readonly Entry[]) =>
  entries.flatMap((entry) => entry.hooks.map((hook) => hook.command));

const denied = ["Bash", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Skill", "TodoWrite"];

describe("BUILD_SESSION_DENIED", () => {
  it("lists the tools a build session may never use", () => {
    expect(BUILD_SESSION_DENIED).toStrictEqual(denied);
  });
});

describe("buildSessionSettings", () => {
  it("allows only Read, Edit, Glob, Grep and Agent", () => {
    expect([...settings().permissions.allow].sort()).toStrictEqual([
      "Agent",
      "Edit",
      "Glob",
      "Grep",
      "Read",
    ]);
  });

  it("denies the build-session deny list", () => {
    expect(settings().permissions.deny).toStrictEqual(denied);
  });

  it("keeps the default permission mode", () => {
    expect(settings().permissions.defaultMode).toBe("default");
  });

  it("runs the guard before every tool call", () => {
    const guards = settings().hooks.PreToolUse.filter((entry) =>
      entry.hooks.some((hook) => hook.command === guardCommand),
    );

    expect(guards).toHaveLength(1);
    expect(["", "*", undefined]).toContain(guards[0]?.matcher);
    expect(guards[0]?.hooks).toStrictEqual([{ type: "command", command: guardCommand }]);
  });

  it("lets the guard answer the permission prompts Claude Code shows for plugin files", () => {
    const { hooks } = settings() as unknown as { hooks: Record<string, Entry[]> };

    expect(hooks.PermissionRequest).toStrictEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: guardCommand }] },
    ]);
  });

  it("forwards PreToolUse, PostToolUse, SubagentStop and Stop to Flowdeck, and nothing else", () => {
    const { hooks } = settings() as unknown as { hooks: Record<string, Entry[]> };

    expect(Object.keys(hooks).sort()).toStrictEqual([
      "PermissionRequest",
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "SubagentStop",
    ]);
    expect([...commandsOf(hooks.PreToolUse ?? [])].sort()).toStrictEqual(
      [guardCommand, hookCommand].sort(),
    );
    for (const event of ["PostToolUse", "SubagentStop", "Stop"]) {
      expect(hooks[event]).toStrictEqual([{ hooks: [{ type: "command", command: hookCommand }] }]);
    }
  });
});

describe("newBuildSessionName", () => {
  const pattern = /^fd-build-[A-Za-z0-9]{8}$/;

  it.each([
    ["a fixed hex source", () => "1a2b3c4d-0000-4000-8000-000000000000"],
    ["randomUUID", randomUUID],
  ])("names an fd-build session from %s", (_label, random) => {
    expect(newBuildSessionName(random)).toMatch(pattern);
  });

  it("takes its name from the randomness it is given", () => {
    const first = newBuildSessionName(() => "1a2b3c4d-0000-4000-8000-000000000000");
    const second = newBuildSessionName(() => "9f8e7d6c-0000-4000-8000-000000000000");

    expect(first).toMatch(pattern);
    expect(second).toMatch(pattern);
    expect(first).not.toBe(second);
  });
});
