import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import { createWaitStore } from "../../../../src/app/renderer/inspector/wait-store.js";
import type { WaitAnswer } from "../../../../src/core/run/wait.js";
import { askWait, gateWait } from "../../../fixtures/waits.js";

type WaitBridge = Pick<FlowdeckBridge, "getWait" | "onWait" | "answerWait">;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const setup = () => {
  const calls: string[] = [];
  let pushListener: (value: unknown) => void = () => undefined;

  const bridge = {
    getWait: vi.fn<() => Promise<unknown>>(async () => {
      calls.push("getWait");
      return null;
    }),
    onWait: vi.fn((listener: (value: unknown) => void) => {
      calls.push("onWait");
      pushListener = listener;
      return () => {};
    }),
    answerWait: vi.fn<(answer: WaitAnswer) => Promise<boolean>>(async () => true),
  } satisfies WaitBridge;

  const wait = createWaitStore({ bridge });
  const push = (value: unknown) => pushListener(value);
  const pending = () => wait.getState().pending;

  return { bridge, wait, calls, push, pending };
};

const connected = async () => {
  const context = setup();
  await context.wait.getState().connect();
  return context;
};

describe("connect", () => {
  it("subscribes to wait pushes before asking for the current wait", async () => {
    const { calls } = await connected();

    expect(calls).toEqual(["onWait", "getWait"]);
  });

  it("shows the wait getWait returns when no push came first", async () => {
    const { bridge, wait, pending } = setup();
    bridge.getWait.mockResolvedValueOnce(gateWait);

    await wait.getState().connect();

    expect(pending()).toEqual(gateWait);
  });

  it("keeps a wait pushed before the fetch answered over the fetched one", async () => {
    const { bridge, wait, push, pending } = setup();
    const answer = deferred<unknown>();
    bridge.getWait.mockReturnValueOnce(answer.promise);

    const connecting = wait.getState().connect();
    push(askWait);
    answer.resolve(gateWait);
    await connecting;

    expect(pending()).toEqual(askWait);
  });

  it("keeps a cleared wait pushed before the fetch answered over the fetched one", async () => {
    const { bridge, wait, push, pending } = setup();
    const answer = deferred<unknown>();
    bridge.getWait.mockReturnValueOnce(answer.promise);

    const connecting = wait.getState().connect();
    push(null);
    answer.resolve(gateWait);
    await connecting;

    expect(pending()).toBeNull();
  });

  it("ignores a fetched value that is not a pending wait", async () => {
    const { bridge, wait, pending } = setup();
    bridge.getWait.mockResolvedValueOnce({ waitId: "wait-1", request: { kind: "vote" } });

    await wait.getState().connect();

    expect(pending()).toBeNull();
  });
});

describe("wait pushes", () => {
  it("stores a pushed wait and clears it on a null push", async () => {
    const { push, pending } = await connected();

    push(gateWait);

    expect(pending()).toEqual(gateWait);

    push(null);

    expect(pending()).toBeNull();
  });

  it("ignores pushes that fail the pending wait schema", async () => {
    const { push, pending } = await connected();
    push(gateWait);

    push({ request: gateWait.request });
    push({ waitId: "wait-3", request: { nodeId: "x", kind: "vote" } });
    push("gate");

    expect(pending()).toEqual(gateWait);
  });
});

describe("answer", () => {
  it("sends the reply with the open wait's id", async () => {
    const { bridge, wait, push } = await connected();
    push(askWait);

    await wait.getState().answer({ decision: "answer", answer: "blue" });

    expect(bridge.answerWait).toHaveBeenCalledWith({
      waitId: "wait-2",
      reply: { decision: "answer", answer: "blue" },
    });
  });

  it("sends nothing when no wait is open", async () => {
    const { bridge, wait } = await connected();

    await wait.getState().answer({ decision: "approve" });

    expect(bridge.answerWait).not.toHaveBeenCalled();
  });

  it("leaves the wait open after answering until a null push clears it", async () => {
    const { wait, push, pending } = await connected();
    push(gateWait);

    await wait.getState().answer({ decision: "approve" });

    expect(pending()).toEqual(gateWait);
  });

  it("resolves and keeps the message when the engine rejects the answer", async () => {
    const { bridge, wait, push } = await connected();
    push(gateWait);
    bridge.answerWait.mockRejectedValueOnce(new Error("engine exited"));

    await expect(wait.getState().answer({ decision: "approve" })).resolves.toBeUndefined();

    expect(wait.getState().error).toBe("engine exited");
  });

  it("clears the message once an answer goes through", async () => {
    const { bridge, wait, push } = await connected();
    push(gateWait);
    bridge.answerWait.mockRejectedValueOnce(new Error("engine exited"));
    await wait.getState().answer({ decision: "approve" });

    await wait.getState().answer({ decision: "approve" });

    expect(wait.getState().error).toBeNull();
  });
});
