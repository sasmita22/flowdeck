import { describe, expect, it } from "vitest";
import type { BlueprintSessionSpec } from "../../src/ports/blueprint-sessions.js";
import { FakeBlueprintSessions } from "./fake-blueprint-sessions.js";

const spec = (session: string): BlueprintSessionSpec => ({
  session,
  cwd: `/fd-home/bp-sessions/${session}`,
  settingsPath: `/fd-home/bp-sessions/${session}/settings.json`,
  mcpConfigPath: `/fd-home/bp-sessions/${session}/mcp.json`,
  kitDir: "/fd-home/kit",
  socketPath: "/fd-home/sock/bp.sock",
});

describe("FakeBlueprintSessions", () => {
  it("records a started spec and reports the session alive", async () => {
    const sessions = new FakeBlueprintSessions();
    const first = spec("fd-bp-alpha");

    await sessions.start(first);

    expect(sessions.started).toEqual([first]);
    expect(await sessions.alive("fd-bp-alpha")).toBe(true);
  });

  it("reports a session that was never started as not alive", async () => {
    const sessions = new FakeBlueprintSessions();

    expect(await sessions.alive("fd-bp-alpha")).toBe(false);
  });

  it("records a stop and reports the session no longer alive", async () => {
    const sessions = new FakeBlueprintSessions();
    await sessions.start(spec("fd-bp-alpha"));
    await sessions.start(spec("fd-bp-beta"));

    await sessions.stop("fd-bp-alpha");

    expect(sessions.stopped).toEqual(["fd-bp-alpha"]);
    expect(await sessions.alive("fd-bp-alpha")).toBe(false);
    expect(await sessions.alive("fd-bp-beta")).toBe(true);
  });

  it("treats stopping a session that is not running as a no-op", async () => {
    const sessions = new FakeBlueprintSessions();
    await sessions.start(spec("fd-bp-beta"));

    await expect(sessions.stop("fd-bp-alpha")).resolves.toBeUndefined();

    expect(await sessions.alive("fd-bp-alpha")).toBe(false);
    expect(await sessions.alive("fd-bp-beta")).toBe(true);
    expect(sessions.started).toEqual([spec("fd-bp-beta")]);
  });
});
