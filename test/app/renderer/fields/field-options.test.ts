import { describe, expect, it } from "vitest";
import { branchSelect, withCurrent } from "../../../../src/app/renderer/fields/field-options.js";

const labels = (options: readonly { label: string }[]) => options.map(({ label }) => label);

describe("branchSelect", () => {
  it("is disabled with a hint while no repository is set", () => {
    const select = branchSelect({
      repo: "",
      value: "",
      branches: { repo: null, branches: null, error: null },
    });

    expect(select.disabled).toBe(true);
    expect(labels(select.options)).toEqual(["Choose a repository first"]);
    expect(select.error).toBeNull();
  });

  it("is disabled while the repository's branches load", () => {
    const select = branchSelect({
      repo: "/repo",
      value: "main",
      branches: { repo: "/repo", branches: null, error: null },
    });

    expect(select.disabled).toBe(true);
    expect(labels(select.options)).toEqual(["Loading branches…"]);
    expect(select.error).toBeNull();
  });

  it("is disabled with the reason alone when the branches cannot be listed", () => {
    const select = branchSelect({
      repo: "/tmp/plain",
      value: "",
      branches: {
        repo: "/tmp/plain",
        branches: null,
        error: "/tmp/plain is not a git repository",
      },
    });

    expect(select.disabled).toBe(true);
    expect(labels(select.options)).toEqual(["No branches"]);
    expect(select.error).toBe("/tmp/plain is not a git repository");
    expect(select.error).not.toContain("Type the branch");
  });

  it("lists the repository's branches with Choose… while none is picked", () => {
    const select = branchSelect({
      repo: "/repo",
      value: "",
      branches: { repo: "/repo", branches: ["main", "dev"], error: null },
    });

    expect(select.disabled).toBe(false);
    expect(select.options).toEqual([
      { value: "", label: "Choose…" },
      { value: "main", label: "main" },
      { value: "dev", label: "dev" },
    ]);
    expect(select.error).toBeNull();
  });

  it("lists only the repository's branches once one is picked", () => {
    const select = branchSelect({
      repo: "/repo",
      value: "dev",
      branches: { repo: "/repo", branches: ["main", "dev"], error: null },
    });

    expect(select.options).toEqual([
      { value: "main", label: "main" },
      { value: "dev", label: "dev" },
    ]);
  });

  it("keeps a saved branch the repository no longer lists as an extra option", () => {
    const select = branchSelect({
      repo: "/repo",
      value: "gone",
      branches: { repo: "/repo", branches: ["main"], error: null },
    });

    expect(select.disabled).toBe(false);
    expect(select.options).toEqual([
      { value: "gone", label: "gone" },
      { value: "main", label: "main" },
    ]);
  });

  it("lists no branches of a repository other than the one set", () => {
    const select = branchSelect({
      repo: "/b",
      value: "",
      branches: { repo: "/a", branches: ["only-in-a"], error: null },
    });

    expect(select.disabled).toBe(true);
    expect(select.options.map(({ value }) => value)).not.toContain("only-in-a");
  });
});

describe("withCurrent", () => {
  const choices = [
    { value: "sonnet", label: "Sonnet (latest)" },
    { value: "opus", label: "Opus (latest)" },
  ];

  it("keeps an unknown value as an extra option", () => {
    expect(withCurrent(choices, "claude-old-1")).toEqual([
      { value: "claude-old-1", label: "claude-old-1" },
      ...choices,
    ]);
  });

  it("adds nothing for a known value", () => {
    expect(withCurrent(choices, "opus")).toEqual(choices);
  });

  it("adds nothing for an empty value", () => {
    expect(withCurrent(choices, "")).toEqual(choices);
  });
});
