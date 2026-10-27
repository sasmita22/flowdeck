import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { build, type BuildResult } from "../../../src/core/compiler/build.js";
import { verify, type VerifyFileSystem } from "../../../src/core/compiler/verify.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, flow, prompt, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const hooks = { nodePath: "/usr/local/bin/node", hookScriptPath: "/fd/bin/flowdeck-hook.mjs" };
const sample = () => flow([prompt("p"), agent("a")], [thenWire("p", "a")]);

const succeeded = (result: BuildResult) => {
  if (!result.ok) throw new Error("build failed");
  return result;
};

const built = async () => {
  const fs = new FakeFileSystem();
  const { dir } = succeeded(await build(sample(), { fs, home, hooks }));
  return { fs, dir };
};

const copyWithout = async (fs: FakeFileSystem, dir: string, omitted: string) => {
  const copy = new FakeFileSystem();
  for (const path of await fs.list(dir)) {
    if (path !== omitted)
      await copy.writeFile(`${dir}/${path}`, await fs.readFile(`${dir}/${path}`));
  }
  return copy;
};

const enoent = () =>
  Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" }) as Error;

const failingList = (error: Error): VerifyFileSystem => ({
  list: async () => {
    throw error;
  },
  readFile: async () => "",
});

describe("verify", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("accepts a fresh build on the real file system adapter", async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd-verify-"));
    const fs = new NodeFileSystem() satisfies VerifyFileSystem;
    const { dir } = succeeded(await build(sample(), { fs, home: tmp, hooks }));

    expect(await verify(dir, { fs })).toStrictEqual({ ok: true });
  });

  it("accepts a fresh build, whose manifest records its own hash", async () => {
    const { fs, dir } = await built();

    expect(await verify(dir, { fs })).toStrictEqual({ ok: true });
  });

  it("names a generated file that was edited", async () => {
    const { fs, dir } = await built();
    await fs.writeFile(`${dir}/commands/p.md`, "tampered");

    expect(await verify(dir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: "commands/p.md", problem: "changed" }],
    });
  });

  it("names a generated file that was deleted", async () => {
    const { fs, dir } = await built();
    const copy = await copyWithout(fs, dir, "agents/a.md");

    expect(await verify(dir, { fs: copy })).toStrictEqual({
      ok: false,
      problems: [{ path: "agents/a.md", problem: "missing" }],
    });
  });

  it("names a file the build did not write", async () => {
    const { fs, dir } = await built();
    await fs.writeFile(`${dir}/.DS_Store`, "");

    expect(await verify(dir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: ".DS_Store", problem: "extra" }],
    });
  });

  it("reports every problem at once, sorted by path", async () => {
    const { fs, dir } = await built();
    const copy = await copyWithout(fs, dir, "settings.json");
    await copy.writeFile(`${dir}/commands/p.md`, "tampered");
    await copy.writeFile(`${dir}/notes.txt`, "stray");

    expect(await verify(dir, { fs: copy })).toStrictEqual({
      ok: false,
      problems: [
        { path: "commands/p.md", problem: "changed" },
        { path: "notes.txt", problem: "extra" },
        { path: "settings.json", problem: "missing" },
      ],
    });
  });

  it("names the manifest when it was edited but every file still matches", async () => {
    const { fs, dir } = await built();
    const manifest = JSON.parse(await fs.readFile(`${dir}/manifest.json`));
    await fs.writeFile(`${dir}/manifest.json`, JSON.stringify({ ...manifest, extra: true }));

    expect(await verify(dir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "changed" }],
    });
  });

  it("names the manifest when it cannot be parsed", async () => {
    const { fs, dir } = await built();
    await fs.writeFile(`${dir}/manifest.json`, "{ not json");

    expect(await verify(dir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "changed" }],
    });
  });

  it("names the manifest when it is gone", async () => {
    const { fs, dir } = await built();
    const copy = await copyWithout(fs, dir, "manifest.json");

    expect(await verify(dir, { fs: copy })).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "missing" }],
    });
  });

  it("names the manifest when the folder name is not its hash", async () => {
    const { fs, dir } = await built();
    const otherDir = `${home}/builds/${"0".repeat(64)}`;
    for (const path of await fs.list(dir)) {
      await fs.writeFile(`${otherDir}/${path}`, await fs.readFile(`${dir}/${path}`));
    }

    expect(await verify(otherDir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "changed" }],
    });
  });

  it("names the manifest once when it lists itself and the folder name is not its hash", async () => {
    const { fs, dir } = await built();
    const otherDir = `${home}/builds/${"0".repeat(64)}`;
    for (const path of await fs.list(dir)) {
      await fs.writeFile(`${otherDir}/${path}`, await fs.readFile(`${dir}/${path}`));
    }
    const manifest = JSON.parse(await fs.readFile(`${otherDir}/manifest.json`));
    await fs.writeFile(
      `${otherDir}/manifest.json`,
      JSON.stringify({ ...manifest, files: { ...manifest.files, "manifest.json": "x" } }),
    );

    expect(await verify(otherDir, { fs })).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "changed" }],
    });
  });

  it("names the manifest as missing when the build folder does not exist", async () => {
    expect(
      await verify(`${home}/builds/${"0".repeat(64)}`, { fs: failingList(enoent()) }),
    ).toStrictEqual({
      ok: false,
      problems: [{ path: "manifest.json", problem: "missing" }],
    });
  });

  it("rethrows any other error from listing the folder", async () => {
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    await expect(
      verify(`${home}/builds/${"0".repeat(64)}`, { fs: failingList(error) }),
    ).rejects.toBe(error);
  });
});
