import { describe, expect, it } from "vitest";
import { FakeProcessRunner } from "./fake-process-runner.js";

describe("FakeProcessRunner", () => {
  it("returns the scripted results in order and records each call", async () => {
    const runner = new FakeProcessRunner([
      { code: 0, stdout: "a\n", stderr: "" },
      { code: 2, stdout: "", stderr: "b\n" },
    ]);

    expect(await runner.run("npm", ["test"], "/repo")).toEqual({
      code: 0,
      stdout: "a\n",
      stderr: "",
    });
    expect(await runner.run("sh", [], "/other")).toEqual({ code: 2, stdout: "", stderr: "b\n" });
    expect(runner.calls).toEqual([
      { command: "npm", args: ["test"], cwd: "/repo" },
      { command: "sh", args: [], cwd: "/other" },
    ]);
  });

  it("rejects a call scripted as an error with that error", async () => {
    const error = new Error("spawn nope ENOENT");
    const runner = new FakeProcessRunner([error]);

    await expect(runner.run("nope", [], "/repo")).rejects.toBe(error);
    expect(runner.calls).toEqual([{ command: "nope", args: [], cwd: "/repo" }]);
  });

  it("rejects a call beyond the scripted results", async () => {
    const runner = new FakeProcessRunner([{ code: 0, stdout: "", stderr: "" }]);
    await runner.run("a", [], "/repo");

    await expect(runner.run("b", [], "/repo")).rejects.toThrow(
      'FakeProcessRunner has no result scripted for call 2 ("b")',
    );
  });
});
