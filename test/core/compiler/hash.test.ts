import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { hashBuild } from "../../../src/core/compiler/hash.js";

const files = () => [
  { path: "settings.json", content: '{\n  "a": 1\n}\n' },
  { path: "commands/p.md", content: "Do it.\n" },
  { path: "agents/a.md", content: "Review it.\n" },
];

describe("hashBuild", () => {
  it("is the sha256 of every path and content, sorted by path, each ended by a NUL", () => {
    const input = [
      { path: "b.md", content: "two" },
      { path: "a.md", content: "one" },
    ];
    const expected = createHash("sha256").update("a.md\0one\0b.md\0two\0").digest("hex");

    expect(hashBuild(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBuild(input)).toBe(expected);
  });

  it("does not depend on the order of its input and leaves the input as it was", () => {
    const input = files();
    const reversed = files().reverse();

    expect(hashBuild(reversed)).toBe(hashBuild(input));
    expect(input).toStrictEqual(files());
    expect(reversed).toStrictEqual(files().reverse());
  });

  it.each([0, 1, 2])("changes when one character of file %i changes", (index) => {
    const changed = files().map((file, i) =>
      i === index ? { ...file, content: `${file.content}x` } : file,
    );

    expect(hashBuild(changed)).not.toBe(hashBuild(files()));
  });

  it("changes when a file is added", () => {
    expect(hashBuild([...files(), { path: "z.md", content: "" }])).not.toBe(hashBuild(files()));
  });

  it("keeps the path and content of a file apart", () => {
    expect(hashBuild([{ path: "a", content: "bc" }])).not.toBe(
      hashBuild([{ path: "ab", content: "c" }]),
    );
  });

  it("hashes a manifest the same with or without its hash field", () => {
    const manifest = { version: 1, nodes: [], wires: [] };
    const without = [...files(), { path: "manifest.json", content: canonicalJson(manifest) }];
    const withHash = [
      ...files(),
      { path: "manifest.json", content: canonicalJson({ ...manifest, hash: "f".repeat(64) }) },
    ];

    expect(hashBuild(withHash)).toBe(hashBuild(without));
  });
});
