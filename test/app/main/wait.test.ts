import { describe, expect, it, vi } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { answerWait, createWaitRelay } from "../../../src/app/main/wait.js";
import type { PendingWait } from "../../../src/core/run/wait.js";
import { tool } from "../../fixtures/activity-entries.js";
import { askWait, budget, gateWait, permission, unconfirmedBudget } from "../../fixtures/waits.js";

const wait = (value: PendingWait | null): EnginePush => ({ push: "wait", value });

const setup = () => {
  const sent: unknown[] = [];
  const relay = createWaitRelay({ send: (value) => sent.push(value) });
  return { relay, sent };
};

describe("createWaitRelay", () => {
  it("has no wait before the first push", () => {
    expect(setup().relay.latest()).toBeNull();
  });

  it("sends each wait push unchanged and keeps it as the latest", () => {
    const { relay, sent } = setup();

    relay.onPush(wait(gateWait));
    relay.onPush(wait(askWait));

    expect(sent).toEqual([gateWait, askWait]);
    expect(relay.latest()).toEqual(askWait);
  });

  it.each([permission, budget, unconfirmedBudget])("sends a $kind wait unchanged", (request) => {
    const { relay, sent } = setup();
    const pending: PendingWait = { waitId: "wait-3", request };

    relay.onPush(wait(pending));

    expect(sent).toEqual([pending]);
    expect(relay.latest()).toEqual(pending);
  });

  it("sends a cleared wait and forgets the latest one", () => {
    const { relay, sent } = setup();

    relay.onPush(wait(gateWait));
    relay.onPush(wait(null));

    expect(sent).toEqual([gateWait, null]);
    expect(relay.latest()).toBeNull();
  });

  it("ignores run-state, session and activity pushes", () => {
    const { relay, sent } = setup();
    relay.onPush(wait(gateWait));

    relay.onPush({ push: "run-state", value: { runId: "run-1", status: "running", nodes: {} } });
    relay.onPush({ push: "session", value: null });
    relay.onPush({ push: "activity", value: { runId: "run-1", entry: tool(1) } });

    expect(sent).toEqual([gateWait]);
    expect(relay.latest()).toEqual(gateWait);
  });

  it("ignores a wait value that is not a pending wait", () => {
    const { relay, sent } = setup();
    relay.onPush(wait(gateWait));

    relay.onPush({ push: "wait", value: { request: gateWait.request } } as unknown as EnginePush);
    relay.onPush({
      push: "wait",
      value: { waitId: "wait-3", request: { nodeId: "x", kind: "vote" } },
    } as unknown as EnginePush);

    expect(sent).toEqual([gateWait]);
    expect(relay.latest()).toEqual(gateWait);
  });
});

describe("answerWait", () => {
  const client = (accepted: boolean) => ({
    request: vi.fn(async () => ({ accepted })),
  });

  it.each([true, false])(
    "forwards a valid answer as answer-wait and returns the engine's accepted %s",
    async (accepted) => {
      const engine = client(accepted);
      const answer = { waitId: "wait-1", reply: { decision: "reject", reason: "" } };

      await expect(answerWait(engine, answer)).resolves.toBe(accepted);
      expect(engine.request).toHaveBeenCalledWith("answer-wait", answer);
    },
  );

  it("forwards a raise answer", async () => {
    const engine = client(true);
    const answer = { waitId: "wait-3", reply: { decision: "raise", budget: 2 } };

    await expect(answerWait(engine, answer)).resolves.toBe(true);
    expect(engine.request).toHaveBeenCalledWith("answer-wait", answer);
  });

  it.each([
    ["a closed decision", { waitId: "wait-1", reply: { decision: "closed" } }],
    ["no wait id", { reply: { decision: "approve" } }],
    ["an unknown decision", { waitId: "wait-1", reply: { decision: "maybe" } }],
    ["a non-object", "approve"],
  ])("refuses %s without asking the engine", async (_name, payload) => {
    const engine = client(true);

    await expect(answerWait(engine, payload)).resolves.toBe(false);
    expect(engine.request).not.toHaveBeenCalled();
  });
});
