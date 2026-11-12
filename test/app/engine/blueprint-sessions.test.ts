import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import {
  createEngineHandler,
  type EngineHandlerOptions,
} from "../../../src/app/engine/engine-handler.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import {
  blueprintSessionFolder,
  blueprintSessionSettings,
  blueprintSocketPath,
  githubMcpServer,
} from "../../../src/core/compiler/blueprint-session.js";
import { hookCommand, shellQuote } from "../../../src/core/compiler/hook-settings.js";
import type { OpenedSession } from "../../../src/core/run/execute.js";
import type { BlueprintSessionSpec } from "../../../src/ports/blueprint-sessions.js";
import { FakeBlueprintSessions } from "../../fakes/fake-blueprint-sessions.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeGithubTokenSource } from "../../fakes/fake-github-token.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";

const isFolder = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

const kitDir = "/flowdeck-kit-blueprint";
const scriptPath = "/flowdeck-mcp/flowdeck-mcp.cjs";
const mcpNodePath = "/usr/local/bin/node";

const specFor = (session: string): BlueprintSessionSpec => ({
  session,
  cwd: `/elsewhere/${session}`,
  settingsPath: `/elsewhere/${session}/settings.json`,
  mcpConfigPath: `/elsewhere/${session}/mcp.json`,
  kitDir,
  socketPath: "/elsewhere/bp.sock",
});

describe("engine blueprint sessions", () => {
  let home: string;
  let otherHome: string;
  let pushes: EnginePush[];
  let sessions: FakeBlueprintSessions;
  let nextId: number;

  const hooks = () => ({
    kind: "ok" as const,
    nodePath: process.execPath,
    hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
    guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
    webGuardScriptPath: `${home}/hooks/flowdeck-web-guard.cjs`,
  });

  const flowdeckServer = () => ({
    command: mcpNodePath,
    args: [scriptPath],
    env: {
      FLOWDECK_BP_SOCK: blueprintSocketPath(home),
      FLOWDECK_BP_SESSION: "fd-bp-flow-1",
    },
  });

  const blueprintWith = (token: string | undefined): EngineHandlerOptions["blueprint"] => ({
    sessions,
    kitDir,
    mcpScript: { nodePath: mcpNodePath, scriptPath },
    githubToken: new FakeGithubTokenSource(token),
  });

  const mcpConfigOf = (flowId: string) => join(blueprintSessionFolder(home, flowId), "mcp.json");

  const optionsFor = (
    at: string,
    overrides: Partial<EngineHandlerOptions> = {},
  ): EngineHandlerOptions => ({
    version: "1.2.3",
    openStores: () => ({ runs: new FakeStore(), flows: new FakeFlowStore() }),
    home: at,
    publish: (push) => pushes.push(push),
    prepareHooks: hooks,
    ...fakeEngineBuildOptions(new NodeFileSystem()),
    isFolder,
    fs: new NodeFileSystem(),
    connectors: new FakeConnectorSource(),
    run: {
      fs: new NodeFileSystem(),
      now: Date.now,
      waiter: new FakeWaiter([]),
      startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
      openSession: async (): Promise<OpenedSession> => {
        throw new Error("no run starts in these tests");
      },
    },
    worktree: new FakeWorktree(),
    gitState: new FakeGitState(),
    transcriptTurns: async () => [],
    blueprint: blueprintWith(undefined),
    ...overrides,
  });

  const handlerAt = (at: string, overrides: Partial<EngineHandlerOptions> = {}) =>
    createEngineHandler(optionsFor(at, overrides));

  const send = (handler: ReturnType<typeof createEngineHandler>, type: string, payload?: unknown) =>
    handler.handle({
      id: nextId++,
      type: type as Parameters<typeof handler.handle>[0]["type"],
      payload,
    });

  const call = async (
    handler: ReturnType<typeof createEngineHandler>,
    type: string,
    payload?: unknown,
  ) => {
    const response = await send(handler, type, payload);
    if (!response?.ok) throw new Error(response?.error ?? `no answer to ${type}`);
    return response.value;
  };

  const sessionPushes = () => pushes.filter((push) => push.push === "session");

  const leftover = async (at: string, flowId: string) => {
    await mkdir(blueprintSessionFolder(at, flowId), { recursive: true });
    await sessions.start(specFor(`fd-bp-${flowId}`));
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-bp-engine-"));
    otherHome = await mkdtemp(join(tmpdir(), "fd-bp-engine-other-"));
    pushes = [];
    sessions = new FakeBlueprintSessions();
    nextId = 1;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(otherHome, { recursive: true, force: true });
  });

  describe("blueprint-session-start", () => {
    it("starts fd-bp-<flowId> in its folder under the home with settings and mcp config", async () => {
      const handler = handlerAt(home);
      const folder = blueprintSessionFolder(home, "flow-1");

      await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      expect(isFolder(folder)).toBe(true);
      expect(sessions.started).toEqual([
        {
          session: "fd-bp-flow-1",
          cwd: folder,
          settingsPath: join(folder, "settings.json"),
          mcpConfigPath: join(folder, "mcp.json"),
          kitDir,
          socketPath: blueprintSocketPath(home),
        },
      ]);
      expect(await sessions.alive("fd-bp-flow-1")).toBe(true);
    });

    it("writes settings.json from blueprintSessionSettings with the prepared Stop hook and web guard commands", async () => {
      const handler = handlerAt(home);

      await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      const written = JSON.parse(
        await readFile(join(blueprintSessionFolder(home, "flow-1"), "settings.json"), "utf8"),
      );
      const prepared = hooks();
      expect(written).toStrictEqual(
        blueprintSessionSettings({
          home,
          hookCommand: hookCommand(prepared),
          webGuardCommand: [prepared.nodePath, prepared.webGuardScriptPath]
            .map(shellQuote)
            .join(" "),
        }),
      );
    });

    it("without a GitHub token writes mcp.json with only the flowdeck server and still starts the pane", async () => {
      const handler = handlerAt(home, { blueprint: blueprintWith(undefined) });

      await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      const written = JSON.parse(await readFile(mcpConfigOf("flow-1"), "utf8"));
      expect(written).toStrictEqual({ mcpServers: { flowdeck: flowdeckServer() } });
      expect(sessions.started.map((spec) => spec.session)).toEqual(["fd-bp-flow-1"]);
    });

    it("with a GitHub token writes the github server second, in a private mcp.json, and nowhere else", async () => {
      const handler = handlerAt(home, { blueprint: blueprintWith("fake-gh-token") });

      await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      const written = JSON.parse(await readFile(mcpConfigOf("flow-1"), "utf8"));
      expect(written).toStrictEqual({
        mcpServers: { flowdeck: flowdeckServer(), github: githubMcpServer("fake-gh-token") },
      });
      expect(Object.keys(written.mcpServers)).toStrictEqual(["flowdeck", "github"]);
      expect((await stat(mcpConfigOf("flow-1"))).mode & 0o777).toBe(0o600);
      expect(sessions.started.map((spec) => spec.session)).toEqual(["fd-bp-flow-1"]);
      expect(JSON.stringify(sessions.started)).not.toContain("fake-gh-token");
      expect(
        await readFile(join(blueprintSessionFolder(home, "flow-1"), "settings.json"), "utf8"),
      ).not.toContain("fake-gh-token");
      expect(JSON.stringify(pushes)).not.toContain("fake-gh-token");
    });

    it("publishes the session push and answers with the session name", async () => {
      const handler = handlerAt(home);

      const value = await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      expect(value).toEqual({ session: "fd-bp-flow-1" });
      expect(sessionPushes()).toEqual([
        { push: "session", runId: "fd-bp-flow-1", value: "fd-bp-flow-1" },
      ]);
    });

    it("reuses a live session: starts nothing new, publishes again and gives the same answer", async () => {
      const handler = handlerAt(home);
      await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      const again = await call(handler, "blueprint-session-start", { flowId: "flow-1" });

      expect(again).toEqual({ session: "fd-bp-flow-1" });
      expect(sessions.started).toHaveLength(1);
      expect(sessionPushes()).toEqual([
        { push: "session", runId: "fd-bp-flow-1", value: "fd-bp-flow-1" },
        { push: "session", runId: "fd-bp-flow-1", value: "fd-bp-flow-1" },
      ]);
    });

    it("answers an error without the blueprint option", async () => {
      const handler = handlerAt(home, { blueprint: undefined });

      const response = await send(handler, "blueprint-session-start", { flowId: "flow-1" });

      expect(response).toMatchObject({ ok: false, error: expect.any(String) });
      expect(existsSync(blueprintSessionFolder(home, "flow-1"))).toBe(false);
    });
  });

  describe("blueprint-session-stop", () => {
    it("stops that flow's session and removes its folder, leaving other flows alone", async () => {
      const handler = handlerAt(home);
      await call(handler, "blueprint-session-start", { flowId: "flow-1" });
      await call(handler, "blueprint-session-start", { flowId: "flow-2" });

      await call(handler, "blueprint-session-stop", { flowId: "flow-1" });

      expect(sessions.stopped).toEqual(["fd-bp-flow-1"]);
      expect(await sessions.alive("fd-bp-flow-1")).toBe(false);
      expect(existsSync(blueprintSessionFolder(home, "flow-1"))).toBe(false);
      expect(await sessions.alive("fd-bp-flow-2")).toBe(true);
      expect(isFolder(blueprintSessionFolder(home, "flow-2"))).toBe(true);
    });
  });

  describe("blueprint-session-stop-all", () => {
    it("stops the session of every folder under bp-sessions and removes the folders", async () => {
      const handler = handlerAt(home);
      await call(handler, "blueprint-session-start", { flowId: "flow-1" });
      await leftover(home, "deleted-flow");

      await call(handler, "blueprint-session-stop-all");

      expect([...sessions.stopped].sort()).toEqual(["fd-bp-deleted-flow", "fd-bp-flow-1"]);
      expect(existsSync(blueprintSessionFolder(home, "flow-1"))).toBe(false);
      expect(existsSync(blueprintSessionFolder(home, "deleted-flow"))).toBe(false);
    });

    it("leaves every session running while another Flowdeck holds the home", async () => {
      await leftover(home, "flow-a");
      const handler = handlerAt(home, { homeLock: { acquire: async () => false } });

      await call(handler, "blueprint-session-stop-all");

      expect(await sessions.alive("fd-bp-flow-a")).toBe(true);
      expect(isFolder(blueprintSessionFolder(home, "flow-a"))).toBe(true);
    });
  });

  describe("startUp", () => {
    it("still reattaches when the sweep fails", async () => {
      await leftover(home, "flow-a");
      vi.spyOn(sessions, "stop").mockRejectedValue(new Error("tmux gone"));
      const runs = new FakeStore();
      const listRuns = vi.spyOn(runs, "listRuns");
      const handler = handlerAt(home, {
        openStores: () => ({ runs, flows: new FakeFlowStore() }),
        homeLock: { acquire: async () => true },
      });

      await handler.startUp();

      expect(listRuns).toHaveBeenCalled();
    });

    it("leaves leftover sessions alone while another Flowdeck holds the home", async () => {
      await leftover(home, "flow-a");
      const handler = handlerAt(home, { homeLock: { acquire: async () => false } });

      await handler.startUp();

      expect(await sessions.alive("fd-bp-flow-a")).toBe(true);
      expect(isFolder(blueprintSessionFolder(home, "flow-a"))).toBe(true);
    });
  });

  describe("sweepBlueprintSessions", () => {
    it("stops every leftover fd-bp session of this home and removes its folder", async () => {
      await leftover(home, "flow-a");
      await leftover(home, "flow-b");
      const handler = handlerAt(home);

      await handler.sweepBlueprintSessions();

      expect([...sessions.stopped].sort()).toEqual(["fd-bp-flow-a", "fd-bp-flow-b"]);
      expect(existsSync(blueprintSessionFolder(home, "flow-a"))).toBe(false);
      expect(existsSync(blueprintSessionFolder(home, "flow-b"))).toBe(false);
    });

    it("touches only fd-bp names: run, build and other homes' sessions stay up", async () => {
      await leftover(home, "flow-a");
      await leftover(otherHome, "flow-other");
      await sessions.start(specFor("fd-run-1a2b3c4d"));
      await sessions.start(specFor("fd-build-TestKit1"));
      await mkdir(join(home, "build-sessions", "fd-build-TestKit1"), { recursive: true });
      const stop = vi.spyOn(sessions, "stop");
      const handler = handlerAt(home);

      await handler.sweepBlueprintSessions();

      expect(stop).toHaveBeenCalledWith("fd-bp-flow-a");
      for (const [name] of stop.mock.calls) expect(name).toMatch(/^fd-bp-/);
      expect(await sessions.alive("fd-run-1a2b3c4d")).toBe(true);
      expect(await sessions.alive("fd-build-TestKit1")).toBe(true);
      expect(await sessions.alive("fd-bp-flow-other")).toBe(true);
      expect(isFolder(blueprintSessionFolder(otherHome, "flow-other"))).toBe(true);
    });

    it("does nothing without the blueprint option", async () => {
      await leftover(home, "flow-a");
      const handler = handlerAt(home, { blueprint: undefined });

      await handler.sweepBlueprintSessions();

      expect(await sessions.alive("fd-bp-flow-a")).toBe(true);
      expect(isFolder(blueprintSessionFolder(home, "flow-a"))).toBe(true);
    });
  });
});
