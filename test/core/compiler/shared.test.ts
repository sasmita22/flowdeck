import { describe, expect, it } from "vitest";
import { layDown, type LayDownDeps } from "../../../src/core/compiler/build.js";
import type { BuildReport } from "../../../src/core/compiler/build-report.js";
import { sha256Hex } from "../../../src/core/compiler/hash.js";
import { applyMerges } from "../../../src/core/compiler/merge.js";
import type { BuildFile, Manifest } from "../../../src/core/compiler/lower.js";
import { scopeLine, type ScopeParts } from "../../../src/core/compiler/scope-line.js";
import {
  applyShared,
  SHARED_PIECE_TOOL,
  type SharedResult,
} from "../../../src/core/compiler/shared.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { agent, gate, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const reviewers = (): Flow =>
  onMainFlow(
    [
      labelled(agent("a"), "Review the draft"),
      labelled(agent("b"), "Review the draft again"),
      labelled(gate("g"), "Look at the draft"),
      labelled(agent("s"), "Ship it"),
    ],
    [thenWire("a", "b"), thenWire("b", "g"), thenWire("g", "s")],
  );

const home = "/fd-home";
const parts: ScopeParts = {
  build: "alpha",
  repo: "carousell-web",
  workspace: `${home}/workspaces/b-alpha-0001`,
};

const deps: LayDownDeps = {
  home,
  workspace: {
    id: "b-alpha-0001",
    name: "alpha",
    repo: "/work/carousell-web",
    base: "main",
    values: {},
  },
};

const laid = async (): Promise<{ files: BuildFile[]; manifest: Manifest }> => {
  const result = await layDown(reviewers(), deps);
  expect(result.ok).toBe(true);
  const files = result.ok ? result.files : [];
  const manifest = JSON.parse(
    files.find((file) => file.path === "manifest.json")?.content ?? "{}",
  ) as Manifest;
  return { files, manifest };
};

type Entry = BuildReport["shared"][number];

const skill = (name: string, usedBy: string[] = ["a", "b"]): Entry => ({
  name,
  kind: "skill",
  usedBy,
});

const contentOf = (files: readonly BuildFile[], path: string): string | undefined =>
  files.find((file) => file.path === path)?.content;

const paths = (files: readonly BuildFile[]) => files.map((file) => file.path).sort();

const frontmatterOf = (content: string): Record<string, unknown> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .filter((line) => line.includes(": "))
      .map((line) => {
        const at = line.indexOf(": ");
        return [line.slice(0, at), JSON.parse(line.slice(at + 2)) as unknown];
      }),
  );
};

const bodyOf = (content: string) => content.replace(/^---\n[\s\S]*?\n---\n/, "");

const expectNothingLaid = (
  result: SharedResult,
  before: { files: BuildFile[]; manifest: Manifest },
) => {
  expect(result.files).toEqual(before.files);
  expect(result.manifest).toEqual(before.manifest);
  expect(result.accepted).toEqual([]);
};

describe("applyShared", () => {
  describe("an accepted entry", () => {
    it.each<[Entry["kind"], string]>([
      ["skill", "plugin/skills/repo-conventions/SKILL.md"],
      ["command", "plugin/commands/repo-conventions.md"],
    ])("lays a %s at %s", async (kind, path) => {
      const before = await laid();

      const { files } = applyShared(before.files, before.manifest, [
        { name: "repo-conventions", kind, usedBy: ["a", "b"] },
      ]);

      expect(paths(files)).toEqual(paths([...before.files, { path, content: "" }]));
    });

    it("drafts frontmatter with the name and a description opening with the build's scope line, then the draft marker line", async () => {
      const before = await laid();

      const { files } = applyShared(before.files, before.manifest, [skill("repo-conventions")]);
      const draft = contentOf(files, "plugin/skills/repo-conventions/SKILL.md") ?? "";

      const fields = frontmatterOf(draft);
      expect(fields.name).toBe("repo-conventions");
      expect(String(fields.description)).toMatch(new RegExp(`^${escaped(scopeLine(parts))} \\S`));
      expect(bodyOf(draft).split("\n")[0]).toMatch(/^@unfilled: /);
    });

    it("adds each draft to the files and to the manifest's files, returning the accepted entries", async () => {
      const before = await laid();
      const entries: Entry[] = [
        skill("repo-conventions"),
        { name: "run-checks", kind: "command", usedBy: ["b", "s"] },
      ];

      const { files, manifest, accepted, rejected } = applyShared(
        before.files,
        before.manifest,
        entries,
      );

      expect(rejected).toEqual([]);
      expect(accepted).toEqual(entries);
      for (const path of [
        "plugin/skills/repo-conventions/SKILL.md",
        "plugin/commands/run-checks.md",
      ]) {
        expect(manifest.files[path], path).toBe(sha256Hex(contentOf(files, path) ?? ""));
      }
      expect(JSON.parse(contentOf(files, "manifest.json") ?? "{}")).toEqual(manifest);
      expect(manifest.nodes).toEqual(before.manifest.nodes);
    });

    it("leaves the files and manifest as they were when nothing is shared", async () => {
      const before = await laid();

      expectNothingLaid(applyShared(before.files, before.manifest, []), before);
    });
  });

  describe("a rejected entry becomes a question and lays nothing", () => {
    it.each<[string, Entry, string]>([
      ["names a node the build does not have", skill("repo-conventions", ["a", "ghost"]), "ghost"],
      ["names fewer than two distinct agents", skill("repo-conventions", ["a", "a"]), "a"],
      ["names a node that is not an agent", skill("repo-conventions", ["a", "g"]), "g"],
      ["has the name of a piece of the build", skill("ship-it"), "a"],
      ["has the orchestrator's name", skill("run"), "a"],
      ["has a name that is not kebab-case", skill("Repo_Conventions"), "a"],
      ["has a name that starts with a digit", skill("2-checks"), "a"],
    ])("an entry that %s", async (_, entry, nodeId) => {
      const before = await laid();

      const result = applyShared(before.files, before.manifest, [entry]);

      expectNothingLaid(result, before);
      expect(result.rejected).toEqual([{ nodeId, text: expect.stringContaining(entry.name) }]);
    });

    it("an entry naming two agents merged into one piece", async () => {
      const laidOut = await laid();
      const before = applyMerges(laidOut.files, laidOut.manifest, [
        { nodeIds: ["a", "b"], reason: "same review" },
      ]);
      expect(before.rejected).toEqual([]);

      const result = applyShared(before.files, before.manifest, [skill("repo-conventions")]);

      expectNothingLaid(result, before);
      expect(result.rejected).toEqual([
        { nodeId: "a", text: expect.stringContaining("repo-conventions") },
      ]);
    });

    it("lays the accepted entries and asks about the rejected one", async () => {
      const before = await laid();

      const result = applyShared(before.files, before.manifest, [
        skill("repo-conventions"),
        skill("run"),
      ]);

      expect(result.accepted).toEqual([skill("repo-conventions")]);
      expect(result.rejected).toHaveLength(1);
      expect(paths(result.files)).toContain("plugin/skills/repo-conventions/SKILL.md");
    });

    it("asks about a second entry with a name already shared", async () => {
      const before = await laid();

      const result = applyShared(before.files, before.manifest, [
        skill("repo-conventions"),
        { name: "repo-conventions", kind: "command", usedBy: ["b", "s"] },
      ]);

      expect(result.accepted).toEqual([skill("repo-conventions")]);
      expect(result.rejected).toEqual([
        { nodeId: "b", text: expect.stringContaining("repo-conventions") },
      ]);
      expect(paths(result.files)).not.toContain("plugin/commands/repo-conventions.md");
    });
  });

  it("names Skill as the tool an agent runs a shared piece with", () => {
    expect(SHARED_PIECE_TOOL).toBe("Skill");
  });
});

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
