import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { narratorPrompt } from "../../src/adapters/claude/claude-narrator.js";

const digestSource = readFileSync(
  fileURLToPath(new URL("../../src/core/run/digest.ts", import.meta.url)),
  "utf8",
);

const digestLines = [
  "Repo",
  "Branch",
  "Instructions",
  "Report",
  "Steps",
  "Files written",
  "Final reply",
  "Run status",
];

describe("the narrator prompt", () => {
  it.each(digestLines)("names the %s line the digest writes", (line) => {
    expect(narratorPrompt).toContain(line);
    expect(digestSource).toMatch(new RegExp("[`\"' ]" + line + ":"));
  });
});
