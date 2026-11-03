import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import { createWaitStore } from "../../../../src/app/renderer/inspector/wait-store.js";
import type { WaitAnswer } from "../../../../src/core/run/wait.js";
import {
  askWait,
  budget,
  gateWait,
  permission,
  unconfirmedBudget,
} from "../../../fixtures/waits.js";

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
    getWait: vi.fn<(runId: string) => Promise<unknown>>(async (runId) => {
      calls.push(`getWait ${runId}`);
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
  const push = (value: unknown, runId = "run-1") => pushListener({ runId, value });
  const pending = () => wait.getState().pending;

  return { bridge, wait, calls, push, pending };
};

const connected = async (runId = "run-1") => {
  const context = setup();
  await context.wait.getState().connect();
  await context.wait.getState().view(runId);
  return context;
};

describe("view", () => {
  it("subscribes to wait pushes, then asks for the viewed run's wait", async () => {
    const { calls, wait } = await connected("run-1");

    expect(calls).toEqual(["onWait", "getWait run-1"]);
    expect(wait.getState().runId).toBe("run-1");
  });

  it("shows the wait getWait returns when no push came first", async () => {
    const { bridge, wait, pending } = setup();
    bridge.getWait.mockResolvedValueOnce(gateWait);
    await wait.getState().connect();

    await wait.getState().view("run-1");

    expect(pending()).toEqual(gateWait);
  });

  it("keeps a wait pushed before the fetch answered over the fetched one", async () => {
    const { bridge, wait, push, pending } = setup();
    await wait.getState().connect();
    const answer = deferred<unknown>();
    bridge.getWait.mockReturnValueOnce(answer.promise);

    const viewing = wait.getState().view("run-1");
    push(askWait);
    answer.resolve(gateWait);
    await viewing;

    expect(pending()).toEqual(askWait);
  });

  it("keeps a cleared wait pushed before the fetch answered over the fetched one", async () => {
    const { bridge, wait, push, pending } = setup();
    await wait.getState().connect();
    const answer = deferred<unknown>();
    bridge.getWait.mockReturnValueOnce(answer.promise);

    const viewing = wait.getState().view("run-1");
    push(null);
    answer.resolve(gateWait);
    await viewing;

    expect(pending()).toBeNull();
  });

  it("ignores a fetched value that is not a pending wait", async () => {
    const { bridge, wait, pending } = setup();
    bridge.getWait.mockResolvedValueOnce({ waitId: "wait-1", request: { kind: "vote" } });
    await wait.getState().connect();

    await wait.getState().view("run-1");

    expect(pending()).toBeNull();
  });

  it("shows only the viewed run's wait, and the other run's once switched to it", async () => {
    const { bridge, wait, push, pending } = await connected("run-1");
    push(gateWait, "run-1");

    push(askWait, "run-2");
    expect(pending()).toEqual(gateWait);

    bridge.getWait.mockResolvedValueOnce(askWait);
    await wait.getState().view("run-2");
    expect(bridge.getWait).toHaveBeenLastCalledWith("run-2");
    expect(pending()).toEqual(askWait);

    push(null, "run-1");
    expect(pending()).toEqual(askWait);
  });

  it("ignores a late wait for a run no longer viewed", async () => {
    const { bridge, wait, pending } = setup();
    await wait.getState().connect();
    const late = deferred<unknown>();
    bridge.getWait.mockReturnValueOnce(late.promise);
    bridge.getWait.mockResolvedValueOnce(null);

    const first = wait.getState().view("run-1");
    await wait.getState().view("run-2");
    late.resolve(gateWait);
    await first;

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

  it.each([permission, budget, unconfirmedBudget])(
    "stores a pushed $kind wait",
    async (request) => {
      const { push, pending } = await connected();
      const pushed = { waitId: "wait-3", request };

      push(pushed);

      expect(pending()).toEqual(pushed);
    },
  );

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
