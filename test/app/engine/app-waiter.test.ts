import { beforeEach, describe, expect, it } from "vitest";
import { createAppWaiter, type AppWaiter } from "../../../src/app/engine/app-waiter.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import type { PendingWait, WaitAnswer, WaitReply } from "../../../src/core/run/wait.js";
import type { Waiter } from "../../../src/ports/waiter.js";
import { budget, gate, permission, pick } from "../../fixtures/waits.js";

const pending = Symbol("pending");

const settled = async (promise: Promise<WaitReply>) => {
  const result = await Promise.race([
    promise,
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 0)),
  ]);
  return result;
};

const runId = "r1";

describe("createAppWaiter", () => {
  let pushes: EnginePush[];
  let waiter: AppWaiter;
  let run: Waiter;

  const waitPushes = (of = runId) =>
    pushes.flatMap((push) =>
      push.push === "wait" && push.runId === of ? [push.value] : [],
    ) as (PendingWait | null)[];

  const opened = (index = 0) => {
    const value = waitPushes().filter((push) => push !== null)[index];
    if (value === undefined) throw new Error(`no wait pushed at ${index}`);
    return value;
  };

  beforeEach(() => {
    pushes = [];
    waiter = createAppWaiter({ push: (message) => pushes.push(message) });
    run = waiter.forRun(runId);
  });

  it("pushes the wait with its request and keeps the reply pending", async () => {
    const reply = run.wait(gate);

    expect(pushes).toEqual([
      { push: "wait", runId, value: { waitId: expect.any(String), request: gate } },
    ]);
    expect(await settled(reply)).toBe(pending);
  });

  it("resolves the wait with a fitting reply to its id, then pushes it cleared", async () => {
    const reply = run.wait(gate);

    expect(waiter.answer({ waitId: opened().waitId, reply: { decision: "approve" } })).toBe(true);

    expect(await settled(reply)).toEqual({ decision: "approve" });
    expect(waitPushes().at(-1)).toBeNull();
  });

  it("refuses an answer with a stale id and keeps the wait pending", async () => {
    const reply = run.wait(gate);

    expect(
      waiter.answer({ waitId: `${opened().waitId}-old`, reply: { decision: "approve" } }),
    ).toBe(false);

    expect(await settled(reply)).toBe(pending);
    expect(waitPushes()).toHaveLength(1);
  });

  it("refuses a second answer to a wait already resolved", async () => {
    const first = run.wait(gate);
    const { waitId } = opened();
    waiter.answer({ waitId, reply: { decision: "approve" } });
    await first;
    const second = run.wait(gate);

    expect(waiter.answer({ waitId, reply: { decision: "reject", reason: "" } })).toBe(false);

    expect(await settled(second)).toBe(pending);
  });

  it("refuses a decision of another kind and keeps the wait pending", async () => {
    const reply = run.wait(gate);

    expect(waiter.answer({ waitId: opened().waitId, reply: { decision: "continue" } })).toBe(false);

    expect(await settled(reply)).toBe(pending);
  });

  it("refuses an ask answer outside its options and keeps the wait pending", async () => {
    const reply = run.wait(pick);

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
      const reply = run.wait(request);
      let outcome: unknown = pending;
      reply.then(
        (value) => (outcome = value),
        (error: unknown) => (outcome = error),
      );
      const { waitId } = opened();

      waiter.drop(runId);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(outcome).toBe(pending);
      expect(waitPushes()).toEqual([{ waitId, request }, null]);
      expect(waiter.answer({ waitId, reply: fitting })).toBe(false);
      expect(outcome).toBe(pending);
    },
  );

  it("pushes nothing when dropped with no wait open", () => {
    waiter.drop(runId);

    expect(pushes).toEqual([]);
  });

  it("gives two waits for the same node different ids", async () => {
    const first = run.wait(pick);
    const firstId = opened(0).waitId;
    waiter.answer({ waitId: firstId, reply: { decision: "answer", answer: "red" } });
    await first;
    run.wait(pick);

    expect(opened(1).waitId).not.toBe(firstId);
  });

  describe("with two waits open together", () => {
    const secondId = "w2";
    let first: Promise<WaitReply>;
    let second: Promise<WaitReply>;

    beforeEach(() => {
      first = run.wait(gate);
      second = run.wait(pick);
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
    const node = run.wait(gate);
    const asked = run.wait(permission);

    waiter.drop(runId);

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(await settled(node)).toBe(pending);
    expect(waitPushes().at(-1)).toBeNull();
    expect(waiter.answer({ waitId: "w2", reply: { decision: "approve" } })).toBe(false);
  });

  it("withdraws an aborted head wait as closed and pushes the next one", async () => {
    const hook = new AbortController();
    const asked = run.wait(permission, hook.signal);
    const next = run.wait(gate);

    hook.abort();

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(waitPushes().at(-1)).toEqual({ waitId: "w2", request: gate });
    expect(await settled(next)).toBe(pending);
    expect(waiter.answer({ waitId: "w1", reply: { decision: "approve" } })).toBe(false);
  });

  it("drops an open permission wait by resolving it closed", async () => {
    const asked = run.wait(permission);
    const { waitId } = opened();

    waiter.drop(runId);

    expect(await settled(asked)).toEqual({ decision: "closed" });
    expect(waitPushes()).toEqual([{ waitId, request: permission }, null]);
  });
  describe("with two runs waiting at once", () => {
    const otherRun = "r2";
    let other: Waiter;

    beforeEach(() => {
      other = waiter.forRun(otherRun);
    });

    it("pushes each run's wait under its own run id", () => {
      run.wait(gate);
      other.wait(pick);

      expect(waitPushes(runId)).toEqual([{ waitId: "w1", request: gate }]);
      expect(waitPushes(otherRun)).toEqual([{ waitId: "w2", request: pick }]);
    });

    it("keeps another run's open wait pushed while this run's queue moves on", async () => {
      const mine = run.wait(gate);
      other.wait(pick);

      waiter.answer({ waitId: "w1", reply: { decision: "approve" } });

      expect(await settled(mine)).toEqual({ decision: "approve" });
      expect(waitPushes(runId).at(-1)).toBeNull();
      expect(waitPushes(otherRun)).toEqual([{ waitId: "w2", request: pick }]);
    });

    it("answers another run's wait by its id while this run's wait stays open", async () => {
      const mine = run.wait(gate);
      const theirs = other.wait(pick);

      expect(waiter.answer({ waitId: "w2", reply: { decision: "answer", answer: "red" } })).toBe(
        true,
      );

      expect(await settled(theirs)).toEqual({ decision: "answer", answer: "red" });
      expect(await settled(mine)).toBe(pending);
      expect(waitPushes(runId)).toEqual([{ waitId: "w1", request: gate }]);
    });

    it("drops only the finished run's waits, leaving the other run's open and answerable", async () => {
      const mine = run.wait(permission);
      const theirs = other.wait(gate);
      const theirPermission = other.wait(permission);
      const otherPushesBefore = waitPushes(otherRun);

      waiter.drop(runId);

      expect(await settled(mine)).toEqual({ decision: "closed" });
      expect(waitPushes(runId).at(-1)).toBeNull();
      expect(waitPushes(otherRun)).toEqual(otherPushesBefore);
      expect(await settled(theirs)).toBe(pending);
      expect(await settled(theirPermission)).toBe(pending);
      expect(waiter.answer({ waitId: "w2", reply: { decision: "approve" } })).toBe(true);
      expect(await settled(theirs)).toEqual({ decision: "approve" });
      expect(waitPushes(otherRun).at(-1)).toEqual({ waitId: "w3", request: permission });
    });

    it("pushes nothing for a run dropped with no wait open, while another run waits", () => {
      other.wait(gate);
      const before = pushes.length;

      waiter.drop(runId);

      expect(pushes).toHaveLength(before);
    });
  });
});
