import { beforeEach, describe, expect, it } from "vitest";
import { createAppWaiter, type AppWaiter } from "../../../src/app/engine/app-waiter.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { PendingWait, WaitReply } from "../../../src/core/run/wait.js";
import { gate, pick } from "../../fixtures/waits.js";

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

  it("drops the wait without resolving it, pushes it cleared, and refuses a later answer", async () => {
    const reply = waiter.wait(gate);
    let outcome: unknown = pending;
    reply.then(
      (value) => (outcome = value),
      (error: unknown) => (outcome = error),
    );
    const { waitId } = opened();

    waiter.drop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outcome).toBe(pending);
    expect(waitPushes()).toEqual([{ waitId, request: gate }, null]);
    expect(waiter.answer({ waitId, reply: { decision: "approve" } })).toBe(false);
    expect(outcome).toBe(pending);
  });

  it("pushes nothing when dropped with no wait open", () => {
    waiter.drop();

    expect(pushes).toEqual([]);
  });

  it("gives two waits for the same node different ids and refuses the first id once the second is open", async () => {
    const first = waiter.wait(pick);
    const firstId = opened(0).waitId;
    waiter.answer({ waitId: firstId, reply: { decision: "answer", answer: "red" } });
    await first;
    const second = waiter.wait(pick);
    const secondId = opened(1).waitId;

    expect(secondId).not.toBe(firstId);
    expect(waiter.answer({ waitId: firstId, reply: { decision: "answer", answer: "blue" } })).toBe(
      false,
    );
    expect(await settled(second)).toBe(pending);
  });
});
