import { beforeEach, describe, expect, it } from "vitest";
import { createAppWaiter, type AppWaiter } from "../../../src/app/engine/app-waiter.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { PendingWait, WaitAnswer, WaitReply } from "../../../src/core/run/wait.js";
import { budget, gate, permission, pick } from "../../fixtures/waits.js";

const pending = Symbol("pending");

const settled = async (promise: Promise<WaitReply>) => {
  const result = await Promise.race([
    promise,
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return result;
};

describe("createAppWaiter", () => {
  let pushes: EnginePush[];
  let waiter: AppWaiter;

  const waitPushes = () =>
    pushes.flatMap((push) => (push.push === "wait" ? [push.value] : [])) as (PendingWait | null)[];

  const opened = (index = 0) => {
    const value = waitPushes().filter((push) => push !== null)[index];
    if (value === undefined) throw new Error(`no wait pushed at ${index}`);
    return value;
  };

  beforeEach(() => {
    pushes = [];
    waiter = createAppWaiter({ push: (message) => pushes.push(message) });
  });

  it("pushes the wait with its request and keeps the reply pending", async () => {
    const reply = waiter.wait(gate);

    expect(pushes).toEqual([
      { push: "wait", value: { waitId: expect.any(String), request: gate } },
    ]);
    expect(await settled(reply)).toBe(pending);
  });

  it("resolves the wait with a fitting reply to its id, then pushes it cleared", async () => {
    const reply = waiter.wait(gate);

    expect(waiter.answer({ waitId: opened().waitId, reply: { decision: "approve" } })).toBe(true);

    expect(await settled(reply)).toEqual({ decision: "approve" });
    expect(waitPushes().at(-1)).toBeNull();
  });

  it("refuses an answer with a stale id and keeps the wait pending", async () => {
    const reply = waiter.wait(gate);

    expect(
      waiter.answer({ waitId: `${opened().waitId}-old`, reply: { decision: "approve" } }),
    ).toBe(false);

    expect(await settled(reply)).toBe(pending);
    expect(waitPushes()).toHaveLength(1);
  });

  it("refuses a second answer to a wait already resolved", async () => {
    const first = waiter.wait(gate);
    const { waitId } = opened();
    waiter.answer({ waitId, reply: { decision: "approve" } });
    await first;
    const second = waiter.wait(gate);

    expect(waiter.answer({ waitId, reply: { decision: "reject", reason: "" } })).toBe(false);

    expect(await settled(second)).toBe(pending);
  });

  it("refuses a decision of another kind and keeps the wait pending", async () => {
    const reply = waiter.wait(gate);

    expect(waiter.answer({ waitId: opened().waitId, reply: { decision: "continue" } })).toBe(false);

    expect(await settled(reply)).toBe(pending);
  });

  it("refuses an ask answer outside its options and keeps the wait pending", async () => {
    const reply = waiter.wait(pick);

    expect(
      waiter.answer({ waitId: opened().waitId, reply: { decision: "answer", answer: "teal" } }),
    ).toBe(false);

    expect(await settled(reply)).toBe(pending);
  });

  it.each([
    { request: gate, fitting: { decision: "approve" } as WaitAnswer["reply"] },
    { request: budget, fitting: { decision: "stop", reason: "" } as WaitAnswer["reply"] },
  ])(
    "drops a $request.kind wait without resolving it, pushes it cleared, and refuses a later answer",
    async ({ request, fitting }) => {
      const reply = waiter.wait(request);
      let outcome: unknown = pending;
      reply.then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error),
      );
      const { waitId } = opened();

      waiter.drop();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcome).toBe(pending);
      expect(waitPushes()).toEqual([{ waitId, request }, null]);
      expect(waiter.answer({ waitId, reply: fitting })).toBe(false);
      expect(outcome).toBe(pending);
    },
  );

  it("pushes nothing when dropped with no wait open", () => {
    waiter.drop();

    expect(pushes).toEqual([]);
  });

  it("gives two waits for the same node different ids", async () => {
    const first = waiter.wait(pick);
    const firstId = opened(0).waitId;
    waiter.answer({ waitId: firstId, reply: { decision: "answer", answer: "red" } });
    await first;
    waiter.wait(pick);

    expect(opened(1).waitId).not.toBe(firstId);
  });

  describe("with two waits open together", () => {
    const secondId = "w2";
    let first: Promise<WaitReply>;
    let second: Promise<WaitReply>;

    beforeEach(() => {
      first = waiter.wait(gate);
      second = waiter.wait(pick);
    });

    it("keeps pushing the first", () => {
      expect(waitPushes()).toEqual([{ waitId: opened().waitId, request: gate }]);
    });

    it("resolves the second answered by its id while the first stays pushed", async () => {
      const shown = opened();

      expect(
        waiter.answer({ waitId: secondId, reply: { decision: "answer", answer: "red" } }),
      ).toBe(true);

      expect(await settled(second)).toEqual({ decision: "answer", answer: "red" });
      expect(await settled(first)).toBe(pending);
      expect(waitPushes().at(-1)).toEqual(shown);
    });

    it("pushes the second once the first is answered, then null once none is left", async () => {
      waiter.answer({ waitId: opened().waitId, reply: { decision: "approve" } });

      expect(await settled(first)).toEqual({ decision: "approve" });
      expect(waitPushes().at(-1)).toEqual({ waitId: secondId, request: pick });

      waiter.answer({ waitId: secondId, reply: { decision: "answer", answer: "blue" } });

      expect(await settled(second)).toEqual({ decision: "answer", answer: "blue" });
      expect(waitPushes().at(-1)).toBeNull();
    });

    it("refuses a reply that does not fit the queued wait", async () => {
      expect(waiter.answer({ waitId: secondId, reply: { decision: "approve" } })).toBe(false);

      expect(await settled(second)).toBe(pending);
    });
  });

  it("drops a queued permission wait by resolving it closed and pushes null", async () => {
    const node = waiter.wait(gate);
    const asked = waiter.wait(permission);

    waiter.drop();

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(await settled(node)).toBe(pending);
    expect(waitPushes().at(-1)).toBeNull();
    expect(waiter.answer({ waitId: "w2", reply: { decision: "approve" } })).toBe(false);
  });

  it("withdraws an aborted head wait as closed and pushes the next one", async () => {
    const hook = new AbortController();
    const asked = waiter.wait(permission, hook.signal);
    const next = waiter.wait(gate);

    hook.abort();

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(waitPushes().at(-1)).toEqual({ waitId: "w2", request: gate });
    expect(await settled(next)).toBe(pending);
    expect(waiter.answer({ waitId: "w1", reply: { decision: "approve" } })).toBe(false);
  });

  it("drops an open permission wait by resolving it closed", async () => {
    const asked = waiter.wait(permission);
    const { waitId } = opened();

    waiter.drop();

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(waitPushes()).toEqual([{ waitId, request: permission }, null]);
  });
});
