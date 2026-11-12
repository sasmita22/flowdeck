import { describe, expect, it } from "vitest";
import { layDown, type LayDownDeps } from "../../../src/core/compiler/build.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import type { BuildFile } from "../../../src/core/compiler/lower.js";
import { orchestratorPath } from "../../../src/core/compiler/orchestrator.js";
import { pieceNames } from "../../../src/core/compiler/pieces.js";
import { scopeLine } from "../../../src/core/compiler/scope-line.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { frontmatter } from "../../fixtures/frontmatter.js";
import { agent, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const sample = (): Flow => {
  const base = onMainFlow(
    [
      labelled(agent("p", { settings: { writes: ["spec.md"] } }), "Draft the spec"),
      labelled(
        agent("a", { settings: { tools: ["Grep"], given: ["spec.md"] } }),
        "Review the draft",
      ),
      labelled(agent("s"), "Ship it"),
    ],
    [thenWire("p", "a"), thenWire("a", "s")],
  );
  return { ...base, session: { ...base.session, allowedTools: ["Read", "Edit", "Grep"] } };
};

type Named = { id: string; name: string; repo: string; folder: string };

const alpha: Named = {
  id: "b-alpha-0001",
  name: "alpha",
  repo: "/work/carousell-web",
  folder: "carousell-web",
};
const beta: Named = {
  id: "b-beta-0002",
  name: "beta",
  repo: "/code/web-app",
  folder: "web-app",
};

const home = "/fd-home";
const workspaceDir = (named: Named) => `${home}/workspaces/${named.id}`;

const depsOf = (named: Named): LayDownDeps => ({
  home,
  workspace: {
    id: named.id,
    name: named.name,
    repo: named.repo,
    base: "main",
    values: {},
    blueprint: { name: "Bugfix", version: 3 },
  },
});

const laidDown = async (named: Named): Promise<BuildFile[]> => {
  const result = await layDown(sample(), depsOf(named));
  expect(result.ok).toBe(true);
  const files = result.ok ? result.files : [];
  expect(files.map((file) => file.path)).toContain(orchestratorPath);
  return files;
};

const isPieceFile = (path: string) =>
  /^plugin\/agents\/[^/]+\.md$/.test(path) || /^plugin\/skills\/[^/]+\/SKILL\.md$/.test(path);

const pieceFiles = (files: readonly BuildFile[]) => files.filter((file) => isPieceFile(file.path));

const normalised = (files: readonly BuildFile[], named: Named) => {
  const tokens: [string, string][] = [
    [workspaceDir(named), "<workspace>"],
    [named.repo, "<repo>"],
    [named.folder, "<repo-folder>"],
    [named.id, "<build-id>"],
    [named.name, "<build>"],
  ];
  const withoutHashes = (file: BuildFile) => {
    if (file.path !== "manifest.json") return file.content;
    const manifest = JSON.parse(file.content) as Record<string, unknown>;
    delete manifest.files;
    return canonicalJson(manifest);
  };
  return Object.fromEntries(
    files.map((file) => [
      file.path,
      tokens.reduce((text, [from, to]) => text.replaceAll(from, to), withoutHashes(file)),
    ]),
  );
};

const references = (content: string) =>
  [...content.matchAll(/(?:`|\/)([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)/g)].map(
    ([, prefix = "", piece = ""]) => ({ prefix, piece }),
  );

describe("layDown", () => {
  describe("AT-1: the structure is fixed", () => {
    it("lays down byte-identical files for the same flow and inputs", async () => {
      expect(await laidDown(alpha)).toStrictEqual(await laidDown(alpha));
    });

    it("gives two builds of one blueprint the same relative paths and the same frontmatter names", async () => {
      const first = await laidDown(alpha);
      const second = await laidDown(beta);
      const names = (files: readonly BuildFile[]) =>
        pieceFiles(files).map((file) => frontmatter(file.content).name);

      expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
      expect(names(second)).toEqual(names(first));
      expect(names(first)).toEqual(
        expect.arrayContaining(["draft-the-spec", "review-the-draft", "ship-it", "run"]),
      );
    });

    it("gives two builds of one blueprint equal contents once the build name, id, repo and workspace are normalised", async () => {
      const first = await laidDown(alpha);
      const second = await laidDown(beta);

      expect(normalised(second, beta)).toStrictEqual(normalised(first, alpha));
    });
  });

  describe("AT-18: every piece is scoped to its own build", () => {
    it.each([alpha, beta])(
      "opens every agent and skill description, the orchestrator's included, with the scope line of $name",
      async (named) => {
        const files = pieceFiles(await laidDown(named));
        const line = scopeLine({
          build: named.name,
          repo: named.folder,
          workspace: workspaceDir(named),
        });

        expect(files.map((file) => file.path).sort()).toEqual([
          "plugin/agents/draft-the-spec.md",
          "plugin/agents/review-the-draft.md",
          "plugin/agents/ship-it.md",
          "plugin/skills/run/SKILL.md",
        ]);
        for (const file of files) {
          const description = String(frontmatter(file.content).description);
          expect(description.slice(0, line.length), file.path).toBe(line);
        }
      },
    );
  });

  describe("AT-17: every reference stays inside the build", () => {
    it.each([alpha, beta])(
      "writes every <name>:<piece> reference with the prefix $name",
      async (named) => {
        const found = (await laidDown(named)).flatMap((file) => references(file.content));

        expect(found).toEqual(
          expect.arrayContaining([{ prefix: named.name, piece: "review-the-draft" }]),
        );
        expect(found.filter(({ prefix }) => prefix !== named.name)).toEqual([]);
      },
    );

    it("uses a bare piece name only as a frontmatter name or a path segment", async () => {
      const pieces = [...pieceNames(sample()).values()];
      const files = (await laidDown(alpha)).filter((file) => file.path !== "manifest.json");

      expect(pieces).toEqual(["draft-the-spec", "review-the-draft", "ship-it"]);
      for (const file of files) {
        for (const piece of pieces) {
          const left = file.content
            .replaceAll(`alpha:${piece}`, "")
            .replaceAll(`name: ${JSON.stringify(piece)}\n`, "")
            .replaceAll(`skills/${piece}/`, "")
            .replaceAll(`agents/${piece}.md`, "");
          expect(left, `${piece} in ${file.path}`).not.toContain(piece);
        }
      }
    });
  });
});
