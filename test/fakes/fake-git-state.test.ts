import { describe, expect, it } from "vitest";
import { FakeGitState } from "./fake-git-state.js";

describe("FakeGitState", () => {
  it("answers each folder with its scripted state and records the reads in order", async () => {
    const git = new FakeGitState({
      "/a": { kind: "branch", name: "fd-demo" },
      "/b": { kind: "not-a-repo" },
    });

    expect(await git.read("/a")).toEqual({ kind: "branch", name: "fd-demo" });
    expect(await git.read("/b")).toEqual({ kind: "not-a-repo" });
    expect(git.reads).toEqual(["/a", "/b"]);
  });

  it("answers a folder it was not given as missing", async () => {
    expect(await new FakeGitState().read("/nowhere")).toEqual({ kind: "missing" });
  });

  it("rejects with the scripted failure and records the read", async () => {
    const git = new FakeGitState({}, { failWith: "git not found" });

    await expect(git.read("/a")).rejects.toThrow("git not found");
    expect(git.reads).toEqual(["/a"]);
  });
});
