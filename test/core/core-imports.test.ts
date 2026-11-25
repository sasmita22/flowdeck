import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/core");

const sources = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

const specifiers = (text: string): string[] =>
  [...text.matchAll(specifierPattern)].map(([, specifier]) => specifier ?? "");

const forbiddenPackage = (specifier: string) =>
  specifier.startsWith("@xyflow/") ||
  specifier === "react" ||
  specifier.startsWith("react/") ||
  specifier === "react-dom" ||
  specifier.startsWith("react-dom/");

const leavesCore = (file: string, specifier: string) => {
  if (!specifier.startsWith(".")) return false;
  const target = relative(core, resolve(dirname(file), specifier));
  return target === ".." || target.startsWith(`..${sep}`);
};

describe("core imports", () => {
  it("imports neither React, React Flow nor anything outside src/core", () => {
    const offending = sources(core).flatMap((file) =>
      specifiers(readFileSync(file, "utf8"))
        .filter((specifier) => forbiddenPackage(specifier) || leavesCore(file, specifier))
        .map((specifier) => `${relative(core, file)} imports ${specifier}`),
    );

    expect(offending).toEqual([]);
  });
});
