import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLines, tokenResults, type TranscriptEntry } from "./live-claude.js";

describe("readLines", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fd-lines-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses each non-empty line as JSON", async () => {
    const path = join(dir, "t.jsonl");
    await writeFile(path, '{"a":1}\n\n{"a":2}\n');

    expect(await readLines(path)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("reads a missing file as no lines", async () => {
    expect(await readLines(join(dir, "missing.jsonl"))).toEqual([]);
  });
});

describe("tokenResults", () => {
  const result = (text: string, isError = false) => ({
    type: "tool_result",
    is_error: isError,
    content: text,
  });

  it("keeps the successful tool results that carry the token", () => {
    const entries: TranscriptEntry[] = [
      { message: { content: [result("fd-perm-1"), result("other"), { type: "text" }] } },
      { message: { content: [result("fd-perm-1", true)] } },
      { message: { content: "fd-perm-1" } },
    ];

    expect(tokenResults(entries, "fd-perm-1")).toEqual([result("fd-perm-1")]);
  });
});
