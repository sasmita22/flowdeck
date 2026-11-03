import { describe, expect, it, vi } from "vitest";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { answerWait, createWaitRelay } from "../../../src/app/main/wait.js";
import type { PendingWait } from "../../../src/core/run/wait.js";
import { tool } from "../../fixtures/activity-entries.js";
import { askWait, budget, gateWait, permission, unconfirmedBudget } from "../../fixtures/waits.js";

const wait = (value: PendingWait | null, runId = "run-1"): EnginePush => ({
  push: "wait",
  runId,
  value,
});

const setup = () => {
  const sent: unknown[] = [];
  const relay = createWaitRelay({ send: (update) => sent.push(update) });
  return { relay, sent };
};

describe("createWaitRelay", () => {
  it("has no wait for a run before its first push", () => {
    expect(setup().relay.latest("run-1")).toBeNull();
  });

  it("sends each wait push with its run id and keeps it as the run's latest", () => {
    const { relay, sent } = setup();

    relay.onPush(wait(gateWait));
    relay.onPush(wait(askWait));

    expect(sent).toEqual([
      { runId: "run-1", value: gateWait },
      { runId: "run-1", value: askWait },
    ]);
    expect(relay.latest("run-1")).toEqual(askWait);
  });

  it.each([permission, budget, unconfirmedBudget])("sends a $kind wait unchanged", (request) => {
    const { relay, sent } = setup();
    const pending: PendingWait = { waitId: "wait-3", request };

    relay.onPush(wait(pending));

    expect(sent).toEqual([{ runId: "run-1", value: pending }]);
    expect(relay.latest("run-1")).toEqual(pending);
  });

  it("sends a cleared wait with its run id and forgets that run's latest one", () => {
    const { relay, sent } = setup();

    relay.onPush(wait(gateWait));
    relay.onPush(wait(null));

    expect(sent).toEqual([
      { runId: "run-1", value: gateWait },
      { runId: "run-1", value: null },
    ]);
    expect(relay.latest("run-1")).toBeNull();
  });

  it("keeps each run's wait when two runs push in turn", () => {
    const { relay } = setup();

    relay.onPush(wait(gateWait, "run-1"));
    relay.onPush(wait(askWait, "run-2"));

    expect(relay.latest("run-1")).toEqual(gateWait);
    expect(relay.latest("run-2")).toEqual(askWait);
  });

  it("clears only the run whose wait is cleared", () => {
    const { relay, sent } = setup();

    relay.onPush(wait(gateWait, "run-1"));
    relay.onPush(wait(askWait, "run-2"));
    relay.onPush(wait(null, "run-2"));

    expect(relay.latest("run-1")).toEqual(gateWait);
    expect(relay.latest("run-2")).toBeNull();
    expect(sent.at(-1)).toEqual({ runId: "run-2", value: null });
  });

  it("ignores run-state, session and activity pushes", () => {
    const { relay, sent } = setup();
    relay.onPush(wait(gateWait));

    relay.onPush({ push: "run-state", value: { runId: "run-1", status: "running", nodes: {} } });
    relay.onPush({ push: "session", runId: "run-1", value: null });
    relay.onPush({ push: "activity", value: { runId: "run-1", entry: tool(1) } });

    expect(sent).toEqual([{ runId: "run-1", value: gateWait }]);
    expect(relay.latest("run-1")).toEqual(gateWait);
  });

  it("ignores a wait value that is not a pending wait", () => {
    const { relay, sent } = setup();
    relay.onPush(wait(gateWait));

    relay.onPush({
      push: "wait",
      runId: "run-1",
      value: { request: gateWait.request },
    } as unknown as EnginePush);
    relay.onPush({
      push: "wait",
      runId: "run-1",
      value: { waitId: "wait-3", request: { nodeId: "x", kind: "vote" } },
    } as unknown as EnginePush);

    expect(sent).toEqual([{ runId: "run-1", value: gateWait }]);
    expect(relay.latest("run-1")).toEqual(gateWait);
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
