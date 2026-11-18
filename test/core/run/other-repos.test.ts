import { describe, expect, it } from "vitest";
import { previewOf, type ActivityEntry } from "../../../src/core/run/activity.js";
import { candidatePaths, toolInputPaths } from "../../../src/core/run/other-repos.js";

const home = "/Users/me";

const tool = (id: number, name: string, input: unknown): ActivityEntry => ({
  id,
  nodeId: "n1",
  at: id,
  summary: "",
  kind: "tool",
  tool: name,
  input: typeof input === "string" ? input : JSON.stringify(input),
});

describe("candidatePaths", () => {
  it("takes file_path, path and notebook_path from each step's input", () => {
    const entries = [
      tool(1, "Read", { file_path: "/x/ios/App.swift" }),
      tool(2, "Grep", { pattern: "foo", path: "/x/web/src" }),
      tool(3, "NotebookEdit", { notebook_path: "/x/data/a.ipynb" }),
    ];
    expect(candidatePaths(entries, { home })).toEqual([
      "/x/data/a.ipynb",
      "/x/ios/App.swift",
      "/x/web/src",
    ]);
  });

  it("takes the folder after cd and git -C in a Bash command", () => {
    const entries = [
      tool(1, "Bash", { command: "cd ~/web && git pull" }),
      tool(2, "Bash", { command: "git -C /x/ios pull --ff-only" }),
    ];
    expect(candidatePaths(entries, { home })).toEqual([`${home}/web`, "/x/ios"]);
  });

  it("skips ~/ paths when no home is given", () => {
    const entries = [
      tool(1, "Bash", { command: "cd ~/web && git pull" }),
      tool(2, "Read", { file_path: "/x/ios/App.swift" }),
    ];
    expect(candidatePaths(entries, {})).toEqual(["/x/ios/App.swift"]);
  });

  it("ignores relative paths", () => {
    const entries = [
      tool(1, "Read", { file_path: "src/App.ts" }),
      tool(2, "Bash", { command: "cd web && git -C ../ios pull" }),
    ];
    expect(candidatePaths(entries, { home })).toEqual([]);
  });

  it("still finds paths in an input cut mid-JSON", () => {
    const long = JSON.stringify({
      command: `cd /x/web && git -C ~/ios pull && echo ${"a".repeat(3_000)}`,
    });
    const cutCommand = previewOf(long);
    const cutEdit = previewOf(
      JSON.stringify({ file_path: "/x/android/Main.kt", old_string: "b".repeat(3_000) }),
    );
    expect(() => {
      JSON.parse(cutCommand);
    }).toThrow();
    expect(
      candidatePaths([tool(1, "Bash", cutCommand), tool(2, "Edit", cutEdit)], { home }),
    ).toEqual(["/Users/me/ios", "/x/android/Main.kt", "/x/web"]);
  });

  it("ignores entries without input and non-tool entries", () => {
    const entries: ActivityEntry[] = [
      { id: 1, nodeId: "n1", at: 1, summary: "cd /x/web", kind: "turn" },
      { id: 2, nodeId: "n1", at: 2, summary: "", kind: "tool", tool: "Bash" },
    ];
    expect(candidatePaths(entries, { home })).toEqual([]);
  });

  it("returns a sorted list with no repeats", () => {
    const entries = [
      tool(1, "Read", { file_path: "/x/b" }),
      tool(2, "Read", { file_path: "/x/a" }),
      tool(3, "Bash", { command: "cd /x/b" }),
    ];
    expect(candidatePaths(entries, { home })).toEqual(["/x/a", "/x/b"]);
  });

  it("keeps at most 200 paths", () => {
    const entries = Array.from({ length: 250 }, (_, index) =>
      tool(index, "Read", { file_path: `/x/${String(index).padStart(3, "0")}` }),
    );
    const paths = candidatePaths(entries, { home });
    expect(paths).toHaveLength(200);
    expect(paths[0]).toBe("/x/000");
    expect(paths[199]).toBe("/x/199");
  });

  it("gives the same output for the same entries", () => {
    const entries = [
      tool(1, "Bash", { command: "cd ~/web && git -C /x/ios status" }),
      tool(2, "Read", { file_path: "/x/a" }),
    ];
    expect(candidatePaths(entries, { home })).toEqual(candidatePaths([...entries], { home }));
  });
});

describe("toolInputPaths", () => {
  const input = (value: object) => JSON.stringify(value);

  it("takes file_path, path and notebook_path from one tool input", () => {
    expect(toolInputPaths(input({ file_path: "/x/ios/App.swift" }), { home })).toEqual([
      "/x/ios/App.swift",
    ]);
    expect(toolInputPaths(input({ pattern: "foo", path: "/x/web/src" }), { home })).toEqual([
      "/x/web/src",
    ]);
    expect(toolInputPaths(input({ notebook_path: "/x/data/a.ipynb" }), { home })).toEqual([
      "/x/data/a.ipynb",
    ]);
  });

  it("takes the folders after cd and git -C in a Bash command, expanding ~/", () => {
    expect(
      toolInputPaths(input({ command: "cd ~/web && git -C /x/ios pull --ff-only" }), { home }),
    ).toEqual([`${home}/web`, "/x/ios"]);
  });

  it("drops relative paths, and ~/ paths when no home is given", () => {
    expect(toolInputPaths(input({ command: "cd web && git -C ../ios pull" }), { home })).toEqual(
      [],
    );
    expect(toolInputPaths(input({ file_path: "src/App.ts" }), { home })).toEqual([]);
    expect(toolInputPaths(input({ command: "cd ~/web && cd /x/ios" }), {})).toEqual(["/x/ios"]);
  });
});
