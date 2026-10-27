import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHookSettings } from "../../../src/adapters/claude/write-hook-settings.js";
import { hookSettings } from "../../../src/core/compiler/hook-settings.js";

const settings = hookSettings({
  nodePath: "/usr/local/bin/node",
  hookScriptPath: "/repo/bin/flowdeck-hook.ts",
});

describe("writeHookSettings", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fd home-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns the settings.json path inside the folder", async () => {
    expect(await writeHookSettings(tmp, settings)).toBe(join(tmp, "settings.json"));
  });

  it("writes the settings as JSON", async () => {
    const path = await writeHookSettings(tmp, settings);

    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual(settings);
  });

  it("creates a session folder that does not exist yet", async () => {
    const dir = join(tmp, "sessions", "0b7c2f4e-1d2a-4c3b-9e8f-5a6b7c8d9e0f");

    const path = await writeHookSettings(dir, settings);

    expect(path).toBe(join(dir, "settings.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual(settings);
  });
});
