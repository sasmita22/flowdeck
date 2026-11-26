import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { narratorPrompt } from "../../src/adapters/claude/claude-narrator.js";
import { otherReposText, repoStateText } from "../../src/core/run/repo-state.js";

const digestSource = readFileSync(
  fileURLToPath(new URL("../../src/core/run/digest.ts", import.meta.url)),
  "utf8",
);

const digestLines = [
  "Repo",
  "Branch",
  "Before",
  "After",
  "Other repos",
  "Instructions",
  "Report",
  "Steps",
  "Files written",
  "Final reply",
  "Run status",
  "Workspace",
];

describe("the narrator prompt", () => {
  it.each(digestLines)("names the %s line the digest writes", (line) => {
    expect(narratorPrompt).toContain(line);
    expect(digestSource).toMatch(new RegExp("[`\"' ]" + line + ":"));
  });

  it("quotes the words the Before and After lines use for an unrecorded state", () => {
    expect(narratorPrompt).toContain(`"${repoStateText(null)}"`);
    expect(narratorPrompt).toContain(`"${repoStateText({ kind: "unreadable" })}"`);
  });

  it("names the before and after the Other repos line gives each repo", () => {
    const line = otherReposText([
      {
        path: "/other",
        branch: "main",
        before: { kind: "unreadable" },
        after: { kind: "unreadable" },
      },
    ]);
    expect(line).toContain(`before ${repoStateText(null)}`);
    expect(line).toContain(`after ${repoStateText(null)}`);
    expect(narratorPrompt).toContain("before and after the Other repos: line gives");
  });
});
