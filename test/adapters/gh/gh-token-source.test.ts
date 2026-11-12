import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhTokenSource } from "../../../src/adapters/gh/gh-token-source.js";

let folder: string;

async function stubGh(body: string): Promise<string> {
  const path = join(folder, "gh");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("GhTokenSource", () => {
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-gh-"));
    vi.spyOn(console, "log");
    vi.spyOn(console, "warn");
    vi.spyOn(console, "error");
  });

  afterEach(async () => {
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("resolves the trimmed token gh auth token prints", async () => {
    const command = await stubGh('[ "$1 $2" = "auth token" ] || exit 2\nprintf "fake-gh-token\\n"');

    await expect(new GhTokenSource({ command }).token()).resolves.toBe("fake-gh-token");
  });

  it("resolves undefined when gh exits non-zero, even after printing a token", async () => {
    const command = await stubGh('printf "fake-gh-token"\necho "not logged in" >&2\nexit 1');

    await expect(new GhTokenSource({ command }).token()).resolves.toBeUndefined();
  });

  it("resolves undefined when gh prints nothing", async () => {
    const command = await stubGh("exit 0");

    await expect(new GhTokenSource({ command }).token()).resolves.toBeUndefined();
  });

  it("resolves undefined when gh is not installed", async () => {
    const command = join(folder, "missing-gh");

    await expect(new GhTokenSource({ command }).token()).resolves.toBeUndefined();
  });
});
