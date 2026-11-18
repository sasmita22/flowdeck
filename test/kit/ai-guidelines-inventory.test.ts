import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoDir = fileURLToPath(new URL("../../", import.meta.url));
const reportPath = join(repoDir, "docs/ai-guidelines-audit.md");
const scannedRoots = ["src", "bin", "kit", "kit-blueprint"];

const filesUnder = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [relative(repoDir, full).split(sep).join("/")];
  });
};

const modelFacingByPlace = [
  /^(?:kit|kit-blueprint)\/.*\.md$/,
  /^src\/core\/compiler\/.*\.ts$/,
  /^src\/core\/nodes\/[^/]+\/(?:compile|execute)\.ts$/,
  /^bin\/.*\.ts$/,
  /^src\/(?:core\/run|core\/flow|adapters\/hook-socket|app\/renderer\/assistant)\/[^/]+\.ts$/,
];

const modelFacingByText = (text: string): boolean =>
  text.includes("sendPrompt(") ||
  /export\s+(?:const|function)\s+\w*(?:Turn|TurnText|Request)\b/.test(text) ||
  text.includes("refuse(");

const isCandidate = (path: string): boolean =>
  modelFacingByPlace.some((pattern) => pattern.test(path)) ||
  modelFacingByText(readFileSync(join(repoDir, path), "utf8"));

const candidates = scannedRoots
  .flatMap((root) => filesUnder(join(repoDir, root)))
  .filter(isCandidate)
  .sort();

const rowsUnder = (markdown: string, heading: string): string[][] => {
  const lines = markdown.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const section = lines.slice(start + 1);
  const end = section.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? section : section.slice(0, end))
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
};

const repoPath = /^[\w.-]+(?:\/[\w.-]+)+\.(?:ts|md)$/;

const pathsIn = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((token) => repoPath.test(token));

const unlisted = (found: readonly string[], listed: ReadonlySet<string>): string[] =>
  found.filter((path) => !listed.has(path));

const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
const inventory = rowsUnder(report, "## Inventory");
const notModelFacing = rowsUnder(report, "## Not model-facing");
const inventoryPaths = inventory.flatMap((row) => pathsIn(row[1] ?? ""));
const notModelFacingPaths = notModelFacing.flatMap((row) => pathsIn(row[0] ?? ""));
const listed = new Set([...inventoryPaths, ...notModelFacingPaths]);

describe("the AI guidelines inventory", () => {
  it("finds model-facing candidates in every kind of place the rule names", () => {
    expect(candidates).toContain("kit-blueprint/skills/blueprint/SKILL.md");
    expect(candidates).toContain("src/core/compiler/rules/ports.ts");
    expect(candidates).toContain("src/core/nodes/agent/execute.ts");
    expect(candidates).toContain("bin/flowdeck-mcp.ts");
    expect(candidates).toContain("src/app/renderer/assistant/tool-handler.ts");
    expect(candidates).toContain("src/adapters/claude/claude-cli.ts");
    expect(candidates).toContain("src/app/renderer/run-store.ts");
  });

  it("lists every file that may hold model-facing text", () => {
    expect(unlisted(candidates, listed)).toEqual([]);
  });

  it("lists no file in both the inventory and the not model-facing table", () => {
    const inventorySet = new Set(inventoryPaths);
    expect(notModelFacingPaths.filter((path) => inventorySet.has(path))).toEqual([]);
  });

  it("gives a reason for every file that holds no model-facing text", () => {
    expect(notModelFacing.length).toBeGreaterThan(0);
    expect(notModelFacing.filter((row) => (row[1] ?? "") === "")).toEqual([]);
  });

  it("lists only files that exist, except planned rows", () => {
    const planned = (row: string[]) => (row[0] ?? "").startsWith("P");
    const missing = [
      ...inventory.filter((row) => !planned(row)).flatMap((row) => pathsIn(row[1] ?? "")),
      ...notModelFacingPaths,
    ].filter((path) => !existsSync(join(repoDir, path)));
    expect(missing).toEqual([]);
  });

  it("reports exactly the path that a listing leaves out", () => {
    const removed = candidates.find((path) => listed.has(path));
    expect(removed).toBeDefined();
    const fewer = new Set([...listed].filter((path) => path !== removed));
    expect(unlisted(candidates, fewer)).toEqual([removed]);
  });
});
