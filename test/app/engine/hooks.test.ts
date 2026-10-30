import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareHooks } from "../../../src/app/engine/hooks.js";

describe("prepareHooks", () => {
  let folder: string;
  let home: string;
  let sourcePath: string;

  const binFolder = async (name: string, node: { executable: boolean } | "none") => {
    const dir = join(folder, name);
    await mkdir(dir, { recursive: true });
    if (node !== "none") {
      await writeFile(join(dir, "node"), "#!/bin/sh\n");
      await chmod(join(dir, "node"), node.executable ? 0o755 : 0o644);
    }
    return dir;
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-hooks-"));
    home = join(folder, "home");
    await mkdir(home);
    sourcePath = join(folder, "dist", "flowdeck-hook.cjs");
    await mkdir(join(folder, "dist"));
    await writeFile(sourcePath, "console.log('hook v2');\n");
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("copies the hook script under the home's hooks folder, creating it, and returns that path", async () => {
    const bin = await binFolder("bin", { executable: true });

    const result = prepareHooks({ home, sourcePath, pathEnv: bin });

    const copy = join(home, "hooks", "flowdeck-hook.cjs");
    expect(result).toEqual({ kind: "ok", nodePath: join(bin, "node"), hookScriptPath: copy });
    expect(await readFile(copy, "utf8")).toBe("console.log('hook v2');\n");
  });

  it("overwrites a stale copy with the current source", async () => {
    const bin = await binFolder("bin", { executable: true });
    await mkdir(join(home, "hooks"));
    await writeFile(join(home, "hooks", "flowdeck-hook.cjs"), "console.log('hook v1');\n");

    prepareHooks({ home, sourcePath, pathEnv: bin });

    expect(await readFile(join(home, "hooks", "flowdeck-hook.cjs"), "utf8")).toBe(
      "console.log('hook v2');\n",
    );
  });

  it("takes node from the first PATH folder whose node is executable", async () => {
    const empty = await binFolder("empty", "none");
    const notExecutable = await binFolder("plain", { executable: false });
    const first = await binFolder("first", { executable: true });
    const second = await binFolder("second", { executable: true });

    const result = prepareHooks({
      home,
      sourcePath,
      pathEnv: [empty, notExecutable, first, second].join(":"),
    });

    expect(result).toMatchObject({ kind: "ok", nodePath: join(first, "node") });
  });

  it("returns an error naming node and PATH when no PATH folder has an executable node", async () => {
    const empty = await binFolder("empty", "none");
    const notExecutable = await binFolder("plain", { executable: false });

    const result = prepareHooks({ home, sourcePath, pathEnv: `${empty}:${notExecutable}` });

    expect(result).toEqual({
      kind: "error",
      message: expect.stringMatching(/node[\s\S]*PATH|PATH[\s\S]*node/),
    });
  });

  it("returns an error naming node and PATH when PATH is not set", () => {
    const result = prepareHooks({ home, sourcePath, pathEnv: undefined });

    expect(result).toEqual({
      kind: "error",
      message: expect.stringMatching(/node[\s\S]*PATH|PATH[\s\S]*node/),
    });
  });

  it("returns an error, without throwing, when the hook source is missing", async () => {
    const bin = await binFolder("bin", { executable: true });

    const result = prepareHooks({
      home,
      sourcePath: join(folder, "dist", "missing.cjs"),
      pathEnv: bin,
    });

    expect(result).toEqual({ kind: "error", message: expect.stringMatching(/\S/) });
  });
});
