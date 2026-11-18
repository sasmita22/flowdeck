import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const releaseVersion = "1.1.0";

const manifest = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, name), "utf8")) as Record<string, unknown>;

const lockPackages = (): Record<string, { version?: string }> =>
  manifest("package-lock.json")["packages"] as Record<string, { version?: string }>;

describe("the release version", () => {
  it.each([
    ["package.json", () => manifest("package.json")["version"]],
    ["package-lock.json", () => manifest("package-lock.json")["version"]],
    ["package-lock.json root package", () => lockPackages()[""]?.version],
  ])("is %s's version", (_name, read) => {
    expect(read()).toBe(releaseVersion);
  });
});
