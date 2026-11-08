import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareMcpScript } from "../../../src/app/engine/mcp-script.js";

describe("prepareMcpScript", () => {
  let folder: string;
  let home: string;
  let bundleDir: string;

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
    folder = await mkdtemp(join(tmpdir(), "fd-mcp-script-"));
    home = join(folder, "home");
    await mkdir(home);
    bundleDir = join(folder, "bundle");
    await mkdir(bundleDir);
    await writeFile(join(bundleDir, "flowdeck-mcp.cjs"), "console.log('mcp v2');\n");
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("copies the bundled script into the home's mcp folder, creating it, and returns its path and node", async () => {
    const bin = await binFolder("bin", { executable: true });

    const result = prepareMcpScript({ bundleDir, home, path: bin });

    const copy = join(home, "mcp", "flowdeck-mcp.cjs");
    expect(result).toEqual({ nodePath: join(bin, "node"), scriptPath: copy });
    expect(await readFile(copy, "utf8")).toBe("console.log('mcp v2');\n");
  });

  it("overwrites a stale copy with the bundled script", async () => {
    const bin = await binFolder("bin", { executable: true });
    await mkdir(join(home, "mcp"));
    await writeFile(join(home, "mcp", "flowdeck-mcp.cjs"), "console.log('mcp v1');\n");

    prepareMcpScript({ bundleDir, home, path: bin });

    expect(await readFile(join(home, "mcp", "flowdeck-mcp.cjs"), "utf8")).toBe(
      "console.log('mcp v2');\n",
    );
  });

  it("takes node from the first PATH folder whose node is executable", async () => {
    const empty = await binFolder("empty", "none");
    const notExecutable = await binFolder("plain", { executable: false });
    const first = await binFolder("first", { executable: true });
    const second = await binFolder("second", { executable: true });

    const result = prepareMcpScript({
      bundleDir,
      home,
      path: [empty, notExecutable, first, second].join(":"),
    });

    expect(result).toMatchObject({ nodePath: join(first, "node") });
  });
});
