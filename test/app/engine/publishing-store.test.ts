import { describe, expect, it } from "vitest";
import { createPublishingStore } from "../../../src/app/engine/publishing-store.js";
import { runSnapshot } from "../../../src/core/run/snapshot.js";
import type { NewRun } from "../../../src/ports/store.js";
import { FakeStore } from "../../fakes/fake-store.js";

const nodeIds = ["p1", "p2"];

const newRun = (): NewRun => ({
  buildDir: "/fd/builds/abc",
  inputs: {},
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
});

const setup = () => {
  const inner = new FakeStore();
  const { id: runId } = inner.createRun(newRun());
  const pushes: unknown[] = [];
  const store = createPublishingStore({
    store: inner,
    runId,
    nodeIds,
    publish: (push: unknown) => pushes.push(push),
  });
  const expected = (status: "running" | "done" | "failed" | "stopped") => ({
    push: "run-state",
    value: runSnapshot({ runId, status, nodeIds, events: inner.events(runId) }),
  });
  return { inner, runId, pushes, store, expected };
};

describe("createPublishingStore", () => {
  it("publishes the run's snapshot after each append", () => {
    const { runId, pushes, store, expected } = setup();

    store.append(runId, "p1", { kind: "sent" });
    const afterFirst = expected("running");
    store.append(runId, "p1", { kind: "done" });

    expect(pushes).toEqual([afterFirst, expected("running")]);
    expect(pushes.at(-1)).toMatchObject({
      value: { runId, status: "running", nodes: { p1: "done", p2: "waiting" } },
    });
  });

  it("publishes one snapshot after an appendAll, with every entry folded in", () => {
    const { runId, pushes, store, expected } = setup();

    store.appendAll(runId, [
      { nodeId: "p1", event: { kind: "sent" } },
      { nodeId: "p1", event: { kind: "done" } },
      { nodeId: "p2", event: { kind: "sent" } },
    ]);

    expect(pushes).toEqual([expected("running")]);
    expect(pushes[0]).toMatchObject({ value: { nodes: { p1: "done", p2: "sent" } } });
  });

  it("publishes a snapshot with the final status after finishRun", () => {
    const { runId, pushes, store, expected } = setup();
    store.append(runId, "p1", { kind: "sent" });
    store.append(runId, "p1", { kind: "done" });
    store.append(runId, "p2", { kind: "running" });
    store.append(runId, "p2", { kind: "failed", payload: { message: "exit code 1" } });

    store.finishRun(runId, "failed");

    expect(pushes.at(-1)).toEqual(expected("failed"));
    expect(pushes.at(-1)).toMatchObject({ value: { status: "failed" } });
  });

  it("delegates the other methods to the inner store and publishes nothing for them", () => {
    const { inner, runId, pushes, store } = setup();

    const created = store.createRun(newRun());
    store.recordBuild({ hash: "h1", dir: "/fd/builds/h1" });
    const found = store.findRun(runId);
    const events = store.events(runId);

    expect(pushes).toEqual([]);
    expect(inner.runs.map((run) => run.id)).toEqual([runId, created.id]);
    expect(inner.builds()).toEqual([{ hash: "h1", dir: "/fd/builds/h1" }]);
    expect(found).toEqual(inner.findRun(runId));
    expect(events).toEqual(inner.events(runId));
  });

  it("passes every write to the inner store unchanged", () => {
    const { inner, runId, store } = setup();

    store.append(runId, "p1", { kind: "sent" });
    store.append(runId, "p1", { kind: "done", payload: { stopMessage: "OK" } });
    store.appendAll(runId, [{ nodeId: "p2", event: { kind: "skipped" } }]);
    store.finishRun(runId, "done");

    expect(inner.events(runId)).toMatchObject([
      { nodeId: "p1", kind: "sent" },
      { nodeId: "p1", kind: "done", payload: { stopMessage: "OK" } },
      { nodeId: "p2", kind: "skipped" },
    ]);
    expect(inner.findRun(runId)?.status).toBe("done");
  });
});
