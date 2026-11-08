import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createToolRelay,
  type ToolRelayRequestEngine,
  type ToolRelaySend,
} from "../../../src/app/main/tool-relay.js";
import { blueprintToolDefinitions, type ToolCall } from "../../../src/core/flow/blueprint-tools.js";
import { FakeToolSocket } from "../../fakes/fake-tool-socket.js";

type Sent = { channel: Parameters<ToolRelaySend>[0]; payload?: unknown };

const setup = async () => {
  const socket = new FakeToolSocket();
  const sent: Sent[] = [];
  const relay = createToolRelay({
    socket,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
  });
  await relay.start("/home/sockets/bp.sock");
  const toolCalls = () =>
    sent.filter((entry) => entry.channel === "toolCall").map((entry) => entry.payload as ToolCall);
  const requestId = (index: number): string => {
    const call = toolCalls()[index];
    if (call === undefined) throw new Error(`no tool call sent at ${index}`);
    return call.requestId;
  };
  return { socket, relay, sent, toolCalls, requestId };
};

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createToolRelay", () => {
  it("listens on the given socket path", async () => {
    const { socket } = await setup();

    expect(socket.listening).toBe("/home/sockets/bp.sock");
  });

  it("answers a tools request with the blueprint tool definitions", async () => {
    const { socket, sent } = await setup();

    await expect(socket.deliver({ kind: "tools", session: "fd-bp-1" })).resolves.toEqual(
      blueprintToolDefinitions(),
    );
    expect(sent).toEqual([]);
  });

  it("sends a canvas tool call to the renderer with a request id and resolves with its answer", async () => {
    const { socket, relay, toolCalls, requestId } = await setup();
    const input = { nodeId: "n1", label: "Plan" };

    const reply = socket.deliver({ kind: "call", session: "fd-bp-1", name: "change_node", input });

    expect(toolCalls()).toEqual([
      { requestId: expect.any(String), session: "fd-bp-1", name: "change_node", input },
    ]);
    relay.answer(requestId(0), { ok: true, problems: [] });
    await expect(reply).resolves.toEqual({ ok: true, problems: [] });
  });

  it("sends a read tool call to the renderer", async () => {
    const { socket, relay, toolCalls, requestId } = await setup();

    const reply = socket.deliver({
      kind: "call",
      session: "fd-bp-1",
      name: "read_blueprint",
      input: {},
    });

    expect(toolCalls()).toEqual([
      { requestId: expect.any(String), session: "fd-bp-1", name: "read_blueprint", input: {} },
    ]);
    relay.answer(requestId(0), { ok: true, flow: { nodes: [] } });
    await expect(reply).resolves.toEqual({ ok: true, flow: { nodes: [] } });
  });

  it("matches two concurrent calls to their own answers by request id", async () => {
    const { socket, relay, requestId } = await setup();

    const first = socket.deliver({
      kind: "call",
      session: "fd-bp-1",
      name: "delete_node",
      input: { nodeId: "a" },
    });
    const second = socket.deliver({
      kind: "call",
      session: "fd-bp-2",
      name: "delete_node",
      input: { nodeId: "b" },
    });

    expect(requestId(0)).not.toBe(requestId(1));
    relay.answer(requestId(1), { ok: true, deleted: "b" });
    relay.answer(requestId(0), { ok: true, deleted: "a" });
    await expect(first).resolves.toEqual({ ok: true, deleted: "a" });
    await expect(second).resolves.toEqual({ ok: true, deleted: "b" });
  });

  it("keeps a call pending with no timer until it is answered", async () => {
    vi.useFakeTimers();
    const { socket, relay, requestId } = await setup();

    const reply = socket.deliver({
      kind: "call",
      session: "fd-bp-1",
      name: "list_blueprints",
      input: {},
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(await settled(reply)).toBe(false);
    relay.answer(requestId(0), { ok: true, blueprints: [] });
    await expect(reply).resolves.toEqual({ ok: true, blueprints: [] });
  });

  it("answers every pending call with the reason on failAll", async () => {
    const { socket, relay } = await setup();

    const first = socket.deliver({
      kind: "call",
      session: "fd-bp-1",
      name: "list_blueprints",
      input: {},
    });
    const second = socket.deliver({
      kind: "call",
      session: "fd-bp-2",
      name: "read_blueprint",
      input: {},
    });
    relay.failAll("the canvas reloaded");

    await expect(first).resolves.toEqual({ ok: false, reason: "the canvas reloaded" });
    await expect(second).resolves.toEqual({ ok: false, reason: "the canvas reloaded" });
  });

  it("sends a turn end to the renderer on stop", async () => {
    const { socket, sent } = await setup();

    await socket.deliver({ kind: "stop" });

    expect(sent.map((entry) => entry.channel)).toEqual(["toolTurnEnd"]);
  });

  it("refuses an unknown tool without asking the renderer", async () => {
    const { socket, sent } = await setup();

    const reply = await socket.deliver({
      kind: "call",
      session: "fd-bp-1",
      name: "run_build",
      input: {},
    });

    expect(reply).toEqual({ ok: false, reason: expect.stringContaining("run_build") });
    expect(sent).toEqual([]);
  });

  describe("build tools", () => {
    const withEngine = async (requestEngine: ToolRelayRequestEngine) => {
      const socket = new FakeToolSocket();
      const sent: Sent[] = [];
      const relay = createToolRelay({
        socket,
        send: (channel, payload) => {
          sent.push({ channel, payload });
        },
        requestEngine,
      });
      await relay.start("/home/sockets/bp.sock");
      return { socket, sent };
    };

    it("sends list_builds to the engine with a 30 s timeout, never to the renderer", async () => {
      const builds = [{ id: "b1", name: "keep", blueprint: "flow-1", version: 2, state: "live" }];
      const requestEngine = vi.fn<ToolRelayRequestEngine>(async () => builds);
      const { socket, sent } = await withEngine(requestEngine);

      const reply = await socket.deliver({
        kind: "call",
        session: "fd-bp-1",
        name: "list_builds",
        input: {},
      });

      expect(requestEngine).toHaveBeenCalledTimes(1);
      const [type, , options] = requestEngine.mock.calls[0] ?? [];
      expect(type).toBe("assistant-list-builds");
      expect(options).toEqual({ timeoutMs: 30_000 });
      expect(reply).toEqual({ ok: true, builds });
      expect(sent).toEqual([]);
    });

    it("sends read_build to the engine with its id and a 30 s timeout, never to the renderer", async () => {
      const read = {
        repo: "/repos/app",
        base: "main",
        values: {},
        workspace: { path: "/fd/workspaces/b1", exists: false, tree: [] },
        worktree: { path: "/fd/workspaces/b1/app", exists: false, dirty: null, unpushed: null },
      };
      const requestEngine = vi.fn<ToolRelayRequestEngine>(async () => read);
      const { socket, sent } = await withEngine(requestEngine);

      const reply = await socket.deliver({
        kind: "call",
        session: "fd-bp-1",
        name: "read_build",
        input: { id: "b1" },
      });

      expect(requestEngine).toHaveBeenCalledWith(
        "assistant-read-build",
        { id: "b1" },
        { timeoutMs: 30_000 },
      );
      expect(reply).toEqual({ ok: true, ...read });
      expect(sent).toEqual([]);
    });

    it("answers an engine error as a failed tool call with its reason", async () => {
      const requestEngine = vi.fn<ToolRelayRequestEngine>(async () => {
        throw new Error("No build nope");
      });
      const { socket, sent } = await withEngine(requestEngine);

      const reply = await socket.deliver({
        kind: "call",
        session: "fd-bp-1",
        name: "read_build",
        input: { id: "nope" },
      });

      expect(reply).toEqual({ ok: false, reason: expect.stringContaining("No build nope") });
      expect(sent).toEqual([]);
    });
  });

  it("closes the socket on close", async () => {
    const { socket, relay } = await setup();

    await relay.close();

    expect(socket.listening).toBeUndefined();
  });
});
