import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditTurn, writeTurn } from "../../../src/core/compiler/build-turns.js";
import type { BuildCheckFailure } from "../../../src/core/compiler/check-build.js";
import type { Manifest, ManifestNode } from "../../../src/core/compiler/lower.js";
import { agent, flow, prompt, script } from "../../fixtures/flow-builders.js";

const kitDir = join(import.meta.dirname, "../../../kit");
const kitAgents = readdirSync(join(kitDir, "agents")).map((file) => file.replace(/\.md$/, ""));
const kitSkills = readdirSync(join(kitDir, "skills"));
const kitNames = [...kitAgents, ...kitSkills];

const node = (
  base: { id: string; type: string; label: string; settings: unknown },
  extra: Partial<ManifestNode> = {},
): ManifestNode => ({
  id: base.id,
  type: base.type as ManifestNode["type"],
  label: base.label,
  settings: base.settings as ManifestNode["settings"],
  ...extra,
});

const targetRepo = "/repos/carousell-web";

const manifest = (): Manifest => {
  const { session: base } = flow([], []);
  const session = { ...base, buildConfig: { ...base.buildConfig, repo: targetRepo } };
  return {
    version: 1,
    prefix: "ship-it",
    kitVersion: "1",
    layout: "workspace",
    session,
    nodes: [
      node(prompt("p1"), { file: "plugin/skills/draft-spec/SKILL.md", piece: "draft-spec" }),
      node(agent("a1"), { file: "plugin/agents/review.md", piece: "review" }),
      node(script("s1")),
      node(prompt("p2"), { file: "plugin/skills/ship/SKILL.md", piece: "ship" }),
    ],
    wires: [],
    files: {},
  };
};

const allPieces = [
  "plugin/skills/draft-spec/SKILL.md",
  "plugin/agents/review.md",
  "script:s1",
  "plugin/templates/spec.md",
  "CLAUDE.md",
];

const pieceLines = (text: string) => text.split("\n").filter((line) => line.startsWith("PIECE "));

const blockOf = (text: string, path: string): string => {
  const lines = text.split("\n");
  const start = lines.indexOf(`PIECE ${path}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("PIECE "));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
};

const expectKitNamesPrefixed = (text: string) => {
  const named = kitNames.filter((name) => text.includes(name));
  expect(named.length).toBeGreaterThan(0);
  for (const name of named) {
    for (const match of text.matchAll(new RegExp(`(\\S*)${name}`, "g"))) {
      expect(match[1]).toMatch(/flowdeck-build:$/);
    }
  }
};

describe("writeTurn", () => {
  it("asks for flowdeck-build:piece-auditor once per piece, all in one message", () => {
    const text = writeTurn(manifest(), allPieces, 1);

    expect(text).toContain("flowdeck-build:piece-auditor");
    expect(text).toMatch(/one message/i);
    expect(pieceLines(text)).toEqual(allPieces.map((path) => `PIECE ${path}`));
  });

  it.each([
    ["plugin/agents/review.md", "agent"],
    ["plugin/skills/draft-spec/SKILL.md", "step"],
    ["plugin/templates/spec.md", "template"],
    ["script:s1", "script"],
    ["CLAUDE.md", "workspace"],
  ])("starts the prompt for %s with its PIECE line, then KIND %s", (path, kind) => {
    const text = writeTurn(manifest(), allPieces, 1);

    expect(text).toContain(`PIECE ${path}\nKIND ${kind}\n`);
  });

  it("names the target repo's absolute path, read only, in every piece's prompt", () => {
    const text = writeTurn(manifest(), allPieces, 1);

    for (const path of allPieces) {
      expect(blockOf(text, path), path).toContain(`\nREPO ${targetRepo}`);
    }
  });

  it("writes only the pieces it is given", () => {
    const text = writeTurn(manifest(), ["plugin/skills/ship/SKILL.md"], 1);

    expect(pieceLines(text)).toEqual(["PIECE plugin/skills/ship/SKILL.md"]);
    expect(text).toContain("PIECE plugin/skills/ship/SKILL.md\nKIND step\n");
  });

  const failures: BuildCheckFailure[] = [
    { file: "plugin/agents/review.md", rule: "unfilled", detail: "an @unfilled line is left" },
    {
      file: "plugin/skills/draft-spec/SKILL.md",
      rule: "description",
      detail: "description is under 60 characters",
    },
  ];

  it("from round 2, carries each failing file with its rule in that piece's prompt", () => {
    const text = writeTurn(manifest(), allPieces, 2, failures);

    for (const failure of failures) {
      const failureLine = blockOf(text, failure.file)
        .split("\n")
        .slice(2)
        .find((line) => line.includes(failure.file) && line.includes(failure.rule));
      expect(failureLine, `${failure.file} ${failure.rule}`).toBeDefined();
    }
    expect(blockOf(text, "plugin/templates/spec.md")).not.toMatch(/unfilled|description/);
  });

  it("carries a failure on a file that is not a piece, with its rule", () => {
    const text = writeTurn(manifest(), ["plugin/agents/review.md"], 3, [
      { file: "settings.json", rule: "code-owned", detail: "differs from what code wrote" },
    ]);

    expect(text.split("\n").some((line) => /settings\.json.*code-owned/.test(line))).toBe(true);
  });

  it("carries no failures in round 1", () => {
    const text = writeTurn(manifest(), allPieces, 1, failures);

    expect(pieceLines(text)).toHaveLength(allPieces.length);
    expect(text).not.toMatch(/\bunfilled\b|\bdescription\b/);
  });

  it("gives every kit name the flowdeck-build: prefix", () => {
    expectKitNamesPrefixed(writeTurn(manifest(), allPieces, 2, failures));
  });
});

describe("auditTurn", () => {
  it("asks for one flowdeck-build:handoff-auditor call with PIECE workspace", () => {
    const text = auditTurn(manifest());

    expect(text).toContain("flowdeck-build:handoff-auditor");
    expect(pieceLines(text)).toEqual(["PIECE workspace"]);
    expect(text).not.toContain("piece-auditor");
  });

  it("names the target repo's absolute path in the auditor's prompt", () => {
    expect(blockOf(auditTurn(manifest()), "workspace")).toContain(`\nREPO ${targetRepo}`);
  });

  it("gives every kit name the flowdeck-build: prefix", () => {
    expectKitNamesPrefixed(auditTurn(manifest()));
  });
});
