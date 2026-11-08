import { describe, expect, it, vi } from "vitest";
import type { ToolSocketMessage } from "../../src/ports/tool-socket.js";
import { FakeToolSocket } from "./fake-tool-socket.js";

const path = "/fd-home/sockets/bp.sock";
const call: ToolSocketMessage = {
  kind: "call",
  session: "fd-bp-flow-1",
  name: "delete_node",
  input: { nodeId: "a1" },
};

describe("FakeToolSocket", () => {
  it("hands a delivered message to the handler and resolves to its reply", async () => {
    const socket = new FakeToolSocket();
    const handler = vi.fn<(message: ToolSocketMessage) => Promise<unknown>>(async () => ({
      ok: true,
    }));
    await socket.listen(path, handler);

    const reply = await socket.deliver(call);

    expect(reply).toEqual({ ok: true });
    expect(handler.mock.calls).toEqual([[call]]);
  });

  it("delivers each kind of message as it was sent", async () => {
    const socket = new FakeToolSocket();
    const seen: ToolSocketMessage[] = [];
    await socket.listen(path, async (message) => {
      seen.push(message);
      return null;
    });
    const tools: ToolSocketMessage = { kind: "tools", session: "fd-bp-flow-1" };
    const stop: ToolSocketMessage = { kind: "stop" };

    await socket.deliver(tools);
    await socket.deliver(call);
    await socket.deliver(stop);

    expect(seen).toEqual([tools, call, stop]);
  });

  it("reports the path it listens on, and nothing before listen or after close", async () => {
    const socket = new FakeToolSocket();
    expect(socket.listening).toBeUndefined();

    await socket.listen(path, async () => null);
    expect(socket.listening).toBe(path);

    await socket.close();
    expect(socket.listening).toBeUndefined();
  });

  it("stops delivering once closed", async () => {
    const socket = new FakeToolSocket();
    const handler = vi.fn(async (): Promise<unknown> => ({ ok: true }));
    await socket.listen(path, handler);

    await socket.close();

    await expect(socket.deliver(call)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
