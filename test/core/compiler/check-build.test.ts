import { describe, expect, it } from "vitest";
import { layDown, type LayDownDeps } from "../../../src/core/compiler/build.js";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import {
  checkBuild,
  type BuildCheckFailure,
  type BuildCheckInputs,
} from "../../../src/core/compiler/check-build.js";
import type { BuildFile, Manifest } from "../../../src/core/compiler/lower.js";
import { orchestratorPath, orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import { scopeLine, type ScopeParts } from "../../../src/core/compiler/scope-line.js";
import { standardRules } from "../../../src/core/compiler/standard-rules.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { agent, fileWire, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const longLabel = "Review the draft spec against the ticket and list every gap found";

const withTools = (base: Flow): Flow => ({
  ...base,
  session: { ...base.session, allowedTools: ["Read", "Edit", "Grep"] },
});

const sample = (): Flow =>
  withTools(
    flow(
      [
        labelled(prompt("p"), "Draft the spec"),
        labelled(agent("a", { settings: { tools: ["Grep"] } }), longLabel),
        labelled(prompt("s"), "Ship it"),
      ],
      [thenWire("p", "a"), thenWire("a", "s"), fileWire("p", "a", "spec.md")],
    ),
  );

const twoReviewers = (): Flow =>
  withTools(
    flow(
      [
        labelled(prompt("p"), "Draft the spec"),
        labelled(agent("a", { settings: { tools: ["Grep"] } }), "Review the draft"),
        labelled(agent("b", { settings: { tools: ["Grep"] } }), "Review the draft again"),
        labelled(prompt("s"), "Ship it"),
      ],
      [thenWire("p", "a"), thenWire("a", "b"), thenWire("b", "s")],
    ),
  );

const home = "/fd-home";
const parts: ScopeParts = {
  build: "alpha",
  repo: "carousell-web",
  workspace: `${home}/workspaces/b-alpha-0001`,
};
const otherParts: ScopeParts = {
  build: "beta",
  repo: "web-app",
  workspace: `${home}/workspaces/b-beta-0002`,
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

const filledDescription =
  "Checks the drafted spec line by line and hands back a list of the gaps it found to the next step.";

const frontmatterBlock = /^---\n([\s\S]*?)\n---\n/;

const withField = (content: string, key: string, value: string | undefined): string =>
  content.replace(frontmatterBlock, (_, fields: string) => {
    const kept = fields.split("\n").filter((line) => !line.startsWith(`${key}: `));
    const added = value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`];
    const [name, ...rest] = kept;
    const lines = key === "name" ? [...added, ...kept] : [name ?? "", ...added, ...rest];
    return `---\n${lines.join("\n")}\n---\n`;
  });

const unfilledLine = /^@unfilled.*\n\n?/m;

const isPieceFile = (path: string) =>
  path !== orchestratorPath &&
  (/^plugin\/agents\/[^/]+\.md$/.test(path) || /^plugin\/skills\/[^/]+\/SKILL\.md$/.test(path));

const describedOnly = (file: BuildFile): BuildFile => ({
  path: file.path,
  content: withField(
    file.content,
    "description",
    `${scopeLine(parts)} ${filledDescription}`,
  ).replace(unfilledLine, ""),
});

const filledOne = (file: BuildFile): BuildFile => {
  if (file.path === "CLAUDE.md") {
    return { path: file.path, content: `${file.content}\n## Repo notes\n\nRun the tests first.\n` };
  }
  if (!isPieceFile(file.path)) return file;
  const described = describedOnly(file);
  return {
    path: file.path,
    content: `${described.content}\n## Worked example\n\nRead the spec, compare it with the ticket, write each gap down.\n`,
  };
};

const laid = async (source: Flow): Promise<BuildFile[]> => {
  const result = await layDown(source, deps);
  expect(result.ok).toBe(true);
  return result.ok ? result.files : [];
};

const manifestOf = (files: readonly BuildFile[]): Manifest =>
  JSON.parse(files.find((file) => file.path === "manifest.json")?.content ?? "{}") as Manifest;

const workspace = async (source: Flow = sample()): Promise<BuildCheckInputs> => {
  const laidDown = await laid(source);
  return {
    laidDown,
    readBack: laidDown.map(filledOne),
    manifest: manifestOf(laidDown),
    flow: source,
  };
};

const fileOf = (inputs: BuildCheckInputs, nodeId: string): string => {
  const file = inputs.manifest.nodes.find((node) => node.id === nodeId)?.file;
  expect(file, nodeId).toBeDefined();
  return file ?? "";
};

const edited = (
  inputs: BuildCheckInputs,
  path: string,
  change: (content: string) => string,
): BuildCheckInputs => {
  expect(inputs.readBack.map((file) => file.path)).toContain(path);
  return {
    ...inputs,
    readBack: inputs.readBack.map((file) =>
      file.path === path ? { path, content: change(file.content) } : file,
    ),
  };
};

const without = (inputs: BuildCheckInputs, path: string): BuildCheckInputs => {
  expect(inputs.readBack.map((file) => file.path)).toContain(path);
  return { ...inputs, readBack: inputs.readBack.filter((file) => file.path !== path) };
};

const failedFiles = (failures: readonly BuildCheckFailure[]) =>
  [...new Set(failures.map((failure) => failure.file))].sort();

const expectFailsOn = (inputs: BuildCheckInputs, file: string) => {
  const failures = checkBuild(inputs);
  expect(failedFiles(failures)).toEqual([file]);
  for (const failure of failures) {
    expect(failure.rule).not.toBe("");
    expect(failure.detail).not.toBe("");
  }
};

const merged = async (): Promise<BuildCheckInputs & { kept: string }> => {
  const source = twoReviewers();
  const before = await laid(source);
  const original = manifestOf(before);
  const keptPiece = original.nodes.find((node) => node.id === "a")?.piece ?? "";
  const keptFile = original.nodes.find((node) => node.id === "a")?.file ?? "";
  const absorbed = original.nodes.find((node) => node.id === "b")?.file ?? "";
  const nodes = original.nodes.map((node) =>
    node.id === "b" ? { ...node, piece: keptPiece, file: keptFile } : node,
  );
  const files = Object.fromEntries(
    Object.entries(original.files).filter(([path]) => path !== absorbed),
  );
  const manifest: Manifest = { ...original, nodes, files };
  const laidDown = before
    .filter((file) => file.path !== absorbed)
    .map((file) => {
      if (file.path === "manifest.json")
        return { path: file.path, content: canonicalJson(manifest) };
      if (file.path === orchestratorPath)
        return orchestratorSkill({ ...manifest, prefix: parts.build }, parts);
      return file;
    });
  return {
    laidDown,
    readBack: laidDown.map(filledOne),
    manifest,
    flow: source,
    kept: keptFile,
  };
};

describe("checkBuild", () => {
  it("passes a workspace whose pieces are filled and whose other files are untouched, templates keeping their @template line", async () => {
    const inputs = await workspace();

    expect(inputs.readBack.map((file) => file.path)).toContain("plugin/templates/spec.md");
    expect(checkBuild(inputs)).toEqual([]);
  });

  describe("AT-2: the structure is complete", () => {
    it("names an agent file that is missing", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(without(inputs, file), file);
    });

    it("counts a merged piece once, from the manifest's node-to-piece map", async () => {
      expect(checkBuild(await merged())).toEqual([]);
    });

    it("names a missing merged piece once", async () => {
      const { kept, ...inputs } = await merged();

      expect(checkBuild(without(inputs, kept))).toEqual([expect.objectContaining({ file: kept })]);
    });

    it("names an extra file under plugin/", async () => {
      const inputs = await workspace();
      const extra = { path: "plugin/skills/extra/SKILL.md", content: "# Extra\n" };

      expectFailsOn({ ...inputs, readBack: [...inputs.readBack, extra] }, extra.path);
    });

    it("names a file that still has an @unfilled line", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) =>
          content.replace(
            frontmatterBlock,
            (block) => `${block}@unfilled: the build agents replace this draft.\n\n`,
          ),
        ),
        file,
      );
    });

    it("names an agent whose description is its label once case and whitespace are folded", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");
      const shouted = `  ${longLabel.toUpperCase().replaceAll(" ", "   ")} `;

      expect(longLabel.length).toBeGreaterThanOrEqual(60);
      expectFailsOn(
        edited(inputs, file, (content) =>
          withField(content, "description", `${scopeLine(parts)} ${shouted}`),
        ),
        file,
      );
    });

    it("names a step skill whose description is under the floor", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "p");

      expectFailsOn(
        edited(inputs, file, (content) =>
          withField(content, "description", `${scopeLine(parts)} Writes the spec down.`),
        ),
        file,
      );
    });
  });

  describe("AT-22: code-owned files are untouched", () => {
    it.each(["plugin/hooks/hooks.json", "plugin/.claude-plugin/plugin.json", "settings.json"])(
      "names %s when it differs by one byte",
      async (file) => {
        expectFailsOn(
          edited(await workspace(), file, (content) => `${content} `),
          file,
        );
      },
    );

    it("names CLAUDE.md when the standard rules are missing", async () => {
      expectFailsOn(
        edited(await workspace(), "CLAUDE.md", (content) =>
          content.replace(standardRules.text, ""),
        ),
        "CLAUDE.md",
      );
    });

    it("names CLAUDE.md when one standard rule is altered", async () => {
      expectFailsOn(
        edited(await workspace(), "CLAUDE.md", (content) =>
          content.replace("after 3 tries", "after 5 tries"),
        ),
        "CLAUDE.md",
      );
    });
  });

  describe("frontmatter and content", () => {
    it("names a step skill whose frontmatter has no name", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "p");

      expectFailsOn(
        edited(inputs, file, (content) => withField(content, "name", undefined)),
        file,
      );
    });

    it("names an agent whose frontmatter has no description", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) => withField(content, "description", undefined)),
        file,
      );
    });

    it("names an agent whose frontmatter name differs from its piece", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) => withField(content, "name", "reviewer")),
        file,
      );
    });

    it("names an agent whose description opens with another build's scope line", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) =>
          withField(content, "description", `${scopeLine(otherParts)} ${filledDescription}`),
        ),
        file,
      );
    });

    it("names an agent whose tools fall outside the run session's allow list", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) => withField(content, "tools", "Grep, Bash")),
        file,
      );
    });

    it("names an agent whose body has nothing beyond its draft", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");
      const draft = inputs.laidDown.find((laidFile) => laidFile.path === file);

      expectFailsOn(
        edited(inputs, file, () => (draft === undefined ? "" : describedOnly(draft).content)),
        file,
      );
    });
  });

  describe("references", () => {
    it("names a File wire whose template is missing", async () => {
      expectFailsOn(
        without(await workspace(), "plugin/templates/spec.md"),
        "plugin/templates/spec.md",
      );
    });

    it("asks no template for a File-wire file that is not markdown", async () => {
      const base = sample();
      const plain = withTools(
        flow(base.nodes, [...base.wires, fileWire("p", "a", "greeting.txt")]),
      );
      const inputs = await workspace(plain);
      const readBack = inputs.readBack.filter(
        (file) => file.path !== "plugin/templates/greeting.txt",
      );

      expect(checkBuild({ ...inputs, readBack })).toEqual([]);
    });

    it("names a file that references a piece this build does not have", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");

      expectFailsOn(
        edited(inputs, file, (content) => `${content}\nHand over to \`alpha:publish-notes\`.\n`),
        file,
      );
    });

    it("names a file that references a piece under another build's prefix", async () => {
      const inputs = await workspace();
      const file = fileOf(inputs, "a");
      const shipIt = inputs.manifest.nodes.find((node) => node.id === "s")?.piece;

      expect(shipIt).toBe("ship-it");
      expectFailsOn(
        edited(inputs, file, (content) => `${content}\nThen call \`beta:${shipIt}\`.\n`),
        file,
      );
    });
  });

  describe("orchestrator", () => {
    const stepLine = /^\d+\. NODE /;

    it("names the orchestrator when its NODE markers are out of manifest order", async () => {
      expectFailsOn(
        edited(await workspace(), orchestratorPath, (content) => {
          const lines = content.split("\n");
          const first = lines.findIndex((line) => stepLine.test(line));
          const [one = "", two = ""] = lines.slice(first, first + 2);
          lines.splice(first, 2, two, one);
          return lines.join("\n");
        }),
        orchestratorPath,
      );
    });

    it("names the orchestrator as missing when the workspace has none", async () => {
      const failures = checkBuild(without(await workspace(), orchestratorPath));

      expect(failures).toContainEqual(
        expect.objectContaining({ file: orchestratorPath, rule: "missing" }),
      );
    });

    it("names the orchestrator when a node's NODE marker is missing", async () => {
      expectFailsOn(
        edited(await workspace(), orchestratorPath, (content) =>
          content
            .split("\n")
            .filter((line) => !/^\d+\. NODE s /.test(line))
            .join("\n")
            .replaceAll(" Then go on to NODE s.", ""),
        ),
        orchestratorPath,
      );
    });
  });
});
