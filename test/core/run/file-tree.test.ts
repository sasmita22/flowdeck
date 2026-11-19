import { describe, expect, it } from "vitest";
import { fileTree } from "../../../src/core/run/file-tree.js";

type FileTreeNode = ReturnType<typeof fileTree>[number];

const lockedFiles = [
  "plugin/templates/h.md",
  "manifest.json",
  "plugin/agents/b.md",
  "plugin/skills/review/SKILL.md",
  "plugin/hooks/hooks.json",
  "CLAUDE.md",
  "plugin/agents/a.md",
  "plugin/commands/go.md",
  "plugin/.claude-plugin/plugin.json",
];

const find = (nodes: FileTreeNode[], path: string): FileTreeNode | undefined => {
  for (const node of nodes) {
    if (node.path === path) return node;
    const inner = find(node.children, path);
    if (inner) return inner;
  }
  return undefined;
};

const folder = (nodes: FileTreeNode[], path: string): FileTreeNode => {
  const node = find(nodes, path);
  expect(node, `no node at ${path}`).toBeDefined();
  expect(node?.kind).toBe("folder");
  return node as FileTreeNode;
};

const everyLevel = (nodes: FileTreeNode[]): FileTreeNode[][] => [
  nodes,
  ...nodes.flatMap((node) => everyLevel(node.children)),
];

describe("fileTree", () => {
  it.each([
    ["plugin/agents", "Agents", "plugin/agents/a.md"],
    ["plugin/templates", "Hand-off templates", "plugin/templates/h.md"],
    ["plugin/skills", "Skills", "plugin/skills/review"],
    ["plugin/hooks", "Hooks", "plugin/hooks/hooks.json"],
  ])("puts what is under %s in a folder labelled %s", (path, label, child) => {
    const node = folder(fileTree(lockedFiles), path);

    expect(node.label).toBe(label);
    expect(node.children.map((inner) => inner.path)).toContain(child);
  });

  it.each([
    ["workspace/plugin/agents", "Agents"],
    ["workspace/plugin/templates", "Hand-off templates"],
    ["sessions/main/plugin/agents", "Agents"],
    ["sessions/main/plugin/skills", "Skills"],
    ["sessions/main/plugin/templates", "Hand-off templates"],
    ["sessions/main/plugin/hooks", "Hooks"],
  ])("labels a container's plugin folder %s as %s", (path, label) => {
    const containerFiles = [
      "workspace/plugin/agents/r.md",
      "workspace/plugin/templates/h.md",
      "sessions/main/plugin/agents/a.md",
      "sessions/main/plugin/skills/review/SKILL.md",
      "sessions/main/plugin/templates/h.md",
      "sessions/main/plugin/hooks/hooks.json",
      "sessions/main/repo/plugin/agents/x.md",
    ];

    expect(folder(fileTree(containerFiles), path).label).toBe(label);
    expect(folder(fileTree(containerFiles), "sessions/main/repo/plugin/agents").label).toBe(
      "agents",
    );
  });

  it.each([
    ["plugin/commands", "commands"],
    ["plugin/.claude-plugin", ".claude-plugin"],
  ])("keeps the raw name as the label of %s", (path, label) => {
    expect(folder(fileTree(lockedFiles), path).label).toBe(label);
  });

  it("nests a skill's files one folder deeper, under the skill's own folder", () => {
    const skill = folder(fileTree(lockedFiles), "plugin/skills/review");

    expect(skill.label).toBe("review");
    expect(skill.children).toEqual([
      expect.objectContaining({
        name: "SKILL.md",
        label: "SKILL.md",
        path: "plugin/skills/review/SKILL.md",
        kind: "file",
      }),
    ]);
  });

  it("keeps CLAUDE.md and manifest.json at the root as files", () => {
    const tree = fileTree(lockedFiles);

    expect(tree.filter((node) => node.kind === "file").map((node) => node.path)).toEqual([
      "CLAUDE.md",
      "manifest.json",
    ]);
  });

  it("gives each node its name, its label and its full relative path", () => {
    const tree = fileTree(lockedFiles);

    expect(find(tree, "plugin/agents/a.md")).toEqual(
      expect.objectContaining({
        name: "a.md",
        label: "a.md",
        path: "plugin/agents/a.md",
        kind: "file",
      }),
    );
    expect(folder(tree, "plugin/agents")).toEqual(
      expect.objectContaining({ name: "agents", path: "plugin/agents", kind: "folder" }),
    );
  });

  it("puts folders before files at every level, each group sorted by name", () => {
    const levels = everyLevel(fileTree([...lockedFiles, "plugin/zz.md", "plugin/aa.md"]));

    for (const level of levels) {
      const folders = level.filter((node) => node.kind === "folder").map((node) => node.name);
      const files = level.filter((node) => node.kind === "file").map((node) => node.name);
      expect(level.map((node) => node.name)).toEqual([...folders, ...files]);
      expect(folders).toEqual([...folders].sort());
      expect(files).toEqual([...files].sort());
    }
    expect(
      folder(fileTree(lockedFiles), "plugin/agents").children.map((node) => node.name),
    ).toEqual(["a.md", "b.md"]);
  });

  it("nests a legacy flat layout under raw-named folders", () => {
    const tree = fileTree(["manifest.json", "commands/x.md", "agents/p.md"]);

    const commands = folder(tree, "commands");
    expect(commands.label).toBe("commands");
    expect(commands.children.map((node) => node.path)).toEqual(["commands/x.md"]);
    expect(folder(tree, "agents").label).toBe("agents");
    expect(tree.map((node) => node.path)).toEqual(["agents", "commands", "manifest.json"]);
  });

  it("lists every path exactly once as a file", () => {
    const files = everyLevel(fileTree(lockedFiles))
      .flat()
      .filter((node) => node.kind === "file")
      .map((node) => node.path)
      .sort();

    expect(files).toEqual([...lockedFiles].sort());
  });

  it("gives an empty tree for no paths", () => {
    expect(fileTree([])).toEqual([]);
  });
});
