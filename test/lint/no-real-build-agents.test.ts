import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)));

const read = (file: string): string => readFileSync(join(repoRoot, file), "utf8");

const adapterOwnTest = "test/adapters/claude/claude-build-agents.test.ts";

const mayImportRealAdapter = (file: string): boolean =>
  file === adapterOwnTest ||
  file.endsWith(".live.test.ts") ||
  file.startsWith("test/fixtures/live-");

const importsRealAdapter = (source: string): boolean =>
  /["'][^"'\n]*\/claude-build-agents(\.js|\.ts)?["']/.test(source);

const buildingSpecs = (): string[] =>
  sourceFilesUnder("e2e")
    .filter((file) => file.endsWith(".spec.ts"))
    .filter((file) => /\b(buildOnCanvas|buildAndRun)\s*\(/.test(read(file)));

describe("no real Claude builds in tests", () => {
  it("keeps the real build-session adapter out of e2e and non-live tests", () => {
    const offenders = [...sourceFilesUnder("e2e"), ...sourceFilesUnder("test")]
      .filter((file) => !mayImportRealAdapter(file))
      .filter((file) => importsRealAdapter(read(file)));

    expect(offenders).toEqual([]);
  });

  it("has a scripted fake claude for e2e", () => {
    expect(existsSync(join(repoRoot, "e2e/fake-claude.ts"))).toBe(true);
  });

  it("finds the building specs it guards", () => {
    expect(buildingSpecs().length).toBeGreaterThan(0);
  });

  it("gives the CLI build fixture fake build agents", () => {
    expect(read("test/fixtures/cli-build.ts")).toMatch(/\bnew FakeBuildAgents\s*\(/);
  });

  it("launches every building spec through launchWithFakeClaude", () => {
    const notThroughFake = buildingSpecs().filter((file) => {
      const source = read(file);
      return !/\blaunchWithFakeClaude\s*\(/.test(source) || /\blaunchApp\s*\(/.test(source);
    });

    expect(notThroughFake).toEqual([]);
  });
});
