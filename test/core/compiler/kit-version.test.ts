import { describe, expect, it } from "vitest";
import { kitVersion } from "../../../src/core/compiler/kit-version.js";

const kit = [
  { path: ".claude-plugin/plugin.json", content: '{"name":"flowdeck-build"}' },
  { path: "agents/piece-auditor.md", content: "---\nname: piece-auditor\n---\n" },
  { path: "skills/write-skill/SKILL.md", content: "---\nname: write-skill\n---\nBody\n" },
];

const shortHex = /^[0-9a-f]{12}$/;

describe("kitVersion", () => {
  it("is 12 lowercase hex characters", () => {
    expect(kitVersion(kit)).toMatch(shortHex);
  });

  it("does not depend on the order the files are given in", () => {
    const forward = kitVersion(kit);
    const reversed = kitVersion([...kit].reverse());

    expect(forward).toMatch(shortHex);
    expect(reversed).toBe(forward);
  });

  it("changes when one byte of one file changes", () => {
    const changed = kit.map((file) =>
      file.path === "skills/write-skill/SKILL.md"
        ? { ...file, content: "---\nname: write-skill\n---\nBodY\n" }
        : file,
    );

    expect(kitVersion(kit)).toMatch(shortHex);
    expect(kitVersion(changed)).toMatch(shortHex);
    expect(kitVersion(changed)).not.toBe(kitVersion(kit));
  });

  it("changes when bytes move between a path and its content", () => {
    const before = kitVersion([{ path: "skills/a", content: "bc" }]);
    const after = kitVersion([{ path: "skills/ab", content: "c" }]);

    expect(before).toMatch(shortHex);
    expect(after).not.toBe(before);
  });

  it("changes when a second file's bytes move into the first", () => {
    const before = kitVersion([
      { path: "a", content: "1" },
      { path: "b", content: "2" },
    ]);
    const after = kitVersion([{ path: "a", content: "1b2" }]);

    expect(before).toMatch(shortHex);
    expect(after).not.toBe(before);
  });

  it("changes when a file's content spells out a second file in null-separated form", () => {
    const before = kitVersion([
      { path: "a", content: "1" },
      { path: "b", content: "2" },
    ]);
    const after = kitVersion([{ path: "a", content: "1\u0000b\u00002" }]);

    expect(before).toMatch(shortHex);
    expect(after).not.toBe(before);
  });
});
