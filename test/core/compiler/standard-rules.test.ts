import { describe, expect, it } from "vitest";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";

const expected = [
  "## Standard rules",
  "",
  "1. Never assume: if the ticket, the code or an explicit answer can't settle what to do, stop and ask, even in auto mode.",
  "2. The target repo's own CLAUDE.md and the guides it names come first; read them at the point of use, never apply rules from memory.",
  "3. Investigate before changing: follow each behaviour past your own area, treat every claim as a question, trace each value to where it is used, search by concept before saying something is missing, and raise contradictions before acting.",
  "4. Make the smallest correct change that matches the existing pattern; no drive-by refactors or speculative code.",
  "5. Fix the cause, never hide the symptom: no no-op patches, commented-out code, removed guards or blind catches.",
  "6. Check your own work before handing off: re-read it against the ask; no stubs or partial work.",
  "7. Write for the next reader: shared names not local paths, no machine state, code by symbol not line number, decisions and their reasons not the conversation.",
  "8. State every change and every deviation from the instructions with its reason.",
  "9. Never rewrite shared history: no force pushes.",
  "",
].join("\n");

describe("standardRules", () => {
  it("is the fixed Standard rules section, character for character", () => {
    expect(standardRules.text).toBe(expected);
  });

  it("is version 1", () => {
    expect(standardRules.version).toBe(1);
  });
});
