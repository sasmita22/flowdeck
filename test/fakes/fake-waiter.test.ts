import { describe, expect, it } from "vitest";
import type { WaitReply, WaitRequest } from "../../src/ports/waiter.js";
import { FakeWaiter } from "./fake-waiter.js";

const gate: WaitRequest = { nodeId: "g1", kind: "gate", shown: "Check the plan" };
const ask: WaitRequest = { nodeId: "q1", kind: "ask", question: "Pick", options: ["a"] };

describe("FakeWaiter", () => {
  it("returns the scripted replies in order and records each request", async () => {
    const waiter = new FakeWaiter([{ decision: "approve" }, { decision: "answer", answer: "a" }]);

    expect(await waiter.wait(gate)).toEqual({ decision: "approve" });
    expect(await waiter.wait(ask)).toEqual({ decision: "answer", answer: "a" });
    expect(waiter.calls).toEqual([gate, ask]);
  });

  it("stays pending on a deferred reply until it resolves, with the request already recorded", async () => {
    let resolve: (reply: WaitReply) => void = () => undefined;
    const deferred = new Promise<WaitReply>((r) => (resolve = r));
    const waiter = new FakeWaiter([deferred]);
    let settled = false;

    const pending = waiter.wait(gate).then((reply) => {
      settled = true;
      return reply;
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(settled).toBe(false);
    expect(waiter.calls).toEqual([gate]);
    resolve({ decision: "reject", reason: "no" });
    expect(await pending).toEqual({ decision: "reject", reason: "no" });
  });

  it("rejects a wait beyond the scripted replies, naming the node", async () => {
    const waiter = new FakeWaiter([{ decision: "approve" }]);
    await waiter.wait(gate);

    await expect(waiter.wait(ask)).rejects.toThrow("FakeWaiter: no scripted reply for q1");
  });

  it("returns a scripted closed reply as is", async () => {
    const waiter = new FakeWaiter([{ decision: "closed" }]);

    expect(await waiter.wait(gate)).toEqual({ decision: "closed" });
  });
});
