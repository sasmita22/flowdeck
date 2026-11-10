import { describe, expect, it } from "vitest";
import { layDown, type LayDownDeps } from "../../../src/core/compiler/build.js";
import { emptyReport, type BuildReport } from "../../../src/core/compiler/build-report.js";
import type { BuildFile, Manifest, ManifestNode } from "../../../src/core/compiler/lower.js";
import { applyMerges, type MergeResult } from "../../../src/core/compiler/merge.js";
import { orchestratorPath, orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import type { ScopeParts } from "../../../src/core/compiler/scope-line.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { agent, gate, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const reviewers = (): Flow =>
  onMainFlow(
    [
      labelled(agent("p"), "Draft the spec"),
      labelled(agent("a"), "Review the draft"),
      labelled(agent("b"), "Review the draft again"),
      labelled(agent("c"), "Check the draft"),
      labelled(gate("g"), "Look at the draft"),
      labelled(agent("s"), "Ship it"),
      labelled(agent("t"), "Ship it now"),
    ],
    [
      thenWire("p", "a"),
      thenWire("a", "b"),
      thenWire("b", "c"),
      thenWire("c", "g"),
      thenWire("g", "s"),
      thenWire("s", "t"),
    ],
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

const nodeOf = (manifest: Manifest, id: string): ManifestNode => {
  const node = manifest.nodes.find((candidate) => candidate.id === id);
  expect(node, id).toBeDefined();
  return node ?? { id, type: "agent", label: "", settings: {} as ManifestNode["settings"] };
};

const fileOf = (manifest: Manifest, id: string): string => {
  const file = nodeOf(manifest, id).file;
  expect(file, id).toBeDefined();
  return file ?? "";
};

const contentOf = (files: readonly BuildFile[], path: string): string | undefined =>
  files.find((file) => file.path === path)?.content;

const paths = (files: readonly BuildFile[]) => files.map((file) => file.path).sort();

const byPath = (files: readonly BuildFile[]) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const merge = (nodeIds: string[]): BuildReport["merges"][number] => ({
  nodeIds,
  reason: "Both review the draft spec against the ticket.",
});

const expectNothingApplied = (
  result: MergeResult,
  before: { files: BuildFile[]; manifest: Manifest },
) => {
  expect(byPath(result.files)).toEqual(byPath(before.files));
  expect(result.manifest).toEqual(before.manifest);
  expect(result.mergedPieces).toEqual([]);
};

const expectQuestionsOn = (
  rejected: MergeResult["rejected"],
  merges: BuildReport["merges"],
): void => {
  expect(rejected).toHaveLength(merges.length);
  rejected.forEach((question, index) => {
    expect(merges[index]?.nodeIds).toContain(question.nodeId);
    expect(question.text.trim()).not.toBe("");
  });
};

describe("applyMerges", () => {
  describe("an accepted merge", () => {
    it("gives every merged node the piece and file of the first node in the node array, whatever the request's order", async () => {
      const before = await laid();
      const first = nodeOf(before.manifest, "a");

      const { manifest } = applyMerges(before.files, before.manifest, [merge(["c", "a", "b"])]);

      for (const id of ["a", "b", "c"]) {
        expect(nodeOf(manifest, id).piece, id).toBe(first.piece);
        expect(nodeOf(manifest, id).file, id).toBe(first.file);
      }
    });

    it("removes the absorbed pieces' files and keeps every other file", async () => {
      const before = await laid();
      const absorbed = [fileOf(before.manifest, "b"), fileOf(before.manifest, "c")];

      const { files } = applyMerges(before.files, before.manifest, [merge(["a", "b", "c"])]);

      expect(paths(files)).toEqual(paths(before.files).filter((path) => !absorbed.includes(path)));
    });

    it("writes the shared piece as a fresh @unfilled draft made from the first node's fields", async () => {
      const before = await laid();
      const shared = fileOf(before.manifest, "a");
      const draft = contentOf(before.files, shared) ?? "";
      const absorbedDraft = contentOf(before.files, fileOf(before.manifest, "b")) ?? "";
      expect(draft).toContain("@unfilled");
      expect(draft).not.toBe(absorbedDraft);

      const { files } = applyMerges(before.files, before.manifest, [merge(["b", "a"])]);

      expect(contentOf(files, shared)).toBe(draft);
    });

    it("lets each merged node keep its own label, settings and place in its manifest node", async () => {
      const before = await laid();
      const shared = nodeOf(before.manifest, "a");

      const { manifest } = applyMerges(before.files, before.manifest, [merge(["a", "b"])]);

      expect(manifest.nodes.map((node) => node.id)).toEqual(
        before.manifest.nodes.map((node) => node.id),
      );
      expect(nodeOf(manifest, "b")).toEqual({
        ...nodeOf(before.manifest, "b"),
        piece: shared.piece,
        file: shared.file,
      });
      expect(nodeOf(manifest, "a")).toEqual(shared);
    });

    it("re-emits the orchestrator so the absorbed node calls the shared piece", async () => {
      const before = await laid();

      const { files, manifest } = applyMerges(before.files, before.manifest, [merge(["a", "b"])]);

      const expected = orchestratorSkill({ ...manifest, prefix: parts.build }, parts).content;
      expect(expected).not.toBe(contentOf(before.files, orchestratorPath));
      expect(contentOf(files, orchestratorPath)).toBe(expected);
    });

    it("writes the merged manifest into manifest.json, its file list matching the files", async () => {
      const before = await laid();

      const { files, manifest } = applyMerges(before.files, before.manifest, [merge(["a", "b"])]);

      expect(JSON.parse(contentOf(files, "manifest.json") ?? "{}")).toEqual(manifest);
      expect(Object.keys(manifest.files).sort()).toEqual(
        paths(files).filter((path) => path !== "manifest.json" && path !== "build-report.json"),
      );
    });

    it("returns the shared piece of each applied merge, once, for a second audit", async () => {
      const before = await laid();

      const result = applyMerges(before.files, before.manifest, [
        merge(["a", "b", "c"]),
        merge(["s", "t"]),
      ]);

      expect(result.mergedPieces).toEqual([
        fileOf(before.manifest, "a"),
        fileOf(before.manifest, "s"),
      ]);
      expect(result.rejected).toEqual([]);
    });
  });

  it("refuses to merge when the laid-down orchestrator has no scope line", async () => {
    const before = await laid();
    const files = before.files.map((file) =>
      file.path === orchestratorPath ? { ...file, content: "# run\n" } : file,
    );

    expect(() => applyMerges(files, before.manifest, [merge(["a", "b"])])).toThrow(
      "the laid-down orchestrator has no scope line",
    );
  });

  describe("a rejected merge becomes a question and is not applied", () => {
    it("rejects merging an agent with a node that is not an agent, naming agents only", async () => {
      const before = await laid();
      const merges = [merge(["a", "g"])];

      const result = applyMerges(before.files, before.manifest, merges);

      expectNothingApplied(result, before);
      expectQuestionsOn(result.rejected, merges);
      expect(result.rejected[0]?.text).toBe("Nodes a, g cannot share a piece: only agents can.");
    });

    it("rejects a merge naming an unknown node", async () => {
      const before = await laid();
      const merges = [merge(["a", "ghost"])];

      const result = applyMerges(before.files, before.manifest, merges);

      expectNothingApplied(result, before);
      expectQuestionsOn(result.rejected, merges);
      expect(result.rejected[0]?.text).toContain("ghost");
    });

    it("rejects both merges when one node appears in two of them", async () => {
      const before = await laid();
      const merges = [merge(["a", "b"]), merge(["b", "c"])];

      const result = applyMerges(before.files, before.manifest, merges);

      expectNothingApplied(result, before);
      expectQuestionsOn(result.rejected, merges);
    });

    it("still applies the valid merges beside a rejected one", async () => {
      const before = await laid();
      const bad = merge(["c", "g"]);

      const result = applyMerges(before.files, before.manifest, [bad, merge(["s", "t"])]);

      expectQuestionsOn(result.rejected, [bad]);
      expect(nodeOf(result.manifest, "t").piece).toBe(nodeOf(before.manifest, "s").piece);
      expect(nodeOf(result.manifest, "c")).toEqual(nodeOf(before.manifest, "c"));
      expect(result.mergedPieces).toEqual([fileOf(before.manifest, "s")]);
    });
  });

  it("changes nothing for keptApart and mixedJobs", async () => {
    const before = await laid();
    const report: BuildReport = {
      ...emptyReport(),
      keptApart: [{ nodeIds: ["a", "b"], reason: "One reviews the spec, the other the code." }],
      mixedJobs: [{ nodeId: "c", note: "Checks the draft and also ships it." }],
    };

    const result = applyMerges(before.files, before.manifest, report.merges);

    expectNothingApplied(result, before);
    expect(result.rejected).toEqual([]);
  });
});
