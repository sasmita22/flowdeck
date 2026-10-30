import { describe, expect, it } from "vitest";
import type { NewRun } from "../../src/ports/store.js";
import { FakeStore } from "./fake-store.js";

const newRun = (nodeIds = ["p1", "p2", "p3"]): NewRun => ({
  buildDir: "/fd/builds/abc",
  inputs: { cwd: "/repo" },
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
});

describe("FakeStore", () => {
  it("creates a running run with a fresh id and finds it by id", () => {
    const store = new FakeStore();

    const first = store.createRun(newRun());
    const second = store.createRun(newRun());

    expect(first.id).not.toBe(second.id);
    expect(first).toEqual({ ...newRun(), id: first.id, status: "running" });
    expect(store.findRun(first.id)).toEqual(first);
    expect(store.findRun("nope")).toBeUndefined();
  });

  it("holds one run entry and one node entry per node id", () => {
    const store = new FakeStore();

    const { id } = store.createRun(newRun());

    expect(store.runs).toHaveLength(1);
    expect(store.nodes).toEqual([
      { runId: id, nodeId: "p1" },
      { runId: id, nodeId: "p2" },
      { runId: id, nodeId: "p3" },
    ]);
  });

  it("returns appended events in order with increasing seq", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());

    store.append(id, "p1", { kind: "sent" });
    store.append(id, "p1", { kind: "done", payload: { stopMessage: "OK" } });
    store.append(id, "p2", { kind: "sent" });

    const events = store.events(id);
    expect(events.map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
      "p1 sent",
      "p1 done",
      "p2 sent",
    ]);
    expect(events[1]).toMatchObject({ payload: { stopMessage: "OK" } });
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });

  it("refuses an event for a node outside the run and keeps the events as they were", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });

    expect(() => store.append(id, "zz", { kind: "sent" })).toThrow();
    expect(() => store.append("nope", "p1", { kind: "sent" })).toThrow();
    expect(store.events(id).map((event) => event.kind)).toEqual(["sent"]);
  });

  it("appends a batch in order, or none of it when one entry is refused", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());

    store.appendAll(id, [
      { nodeId: "p1", event: { kind: "sent" } },
      { nodeId: "p2", event: { kind: "sent" } },
    ]);
    expect(() =>
      store.appendAll(id, [
        { nodeId: "p1", event: { kind: "done" } },
        { nodeId: "zz", event: { kind: "sent" } },
      ]),
    ).toThrow();

    expect(store.events(id).map(({ nodeId, kind }) => `${nodeId} ${kind}`)).toEqual([
      "p1 sent",
      "p2 sent",
    ]);
  });

  it("records the status a run finished with", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());

    store.finishRun(id, "done");

    expect(store.findRun(id)?.status).toBe("done");
  });

  it("keeps one build per hash however often it is recorded", () => {
    const store = new FakeStore();

    store.recordBuild({ hash: "h1", dir: "/fd/builds/h1" });
    store.recordBuild({ hash: "h1", dir: "/fd/builds/h1" });

    expect(store.builds()).toEqual([{ hash: "h1", dir: "/fd/builds/h1" }]);
  });

  it("keeps the build hash a run was created with, and none when it was given none", () => {
    const store = new FakeStore();

    const withBuild = store.createRun({ ...newRun(), buildHash: "h1" });
    const withoutBuild = store.createRun(newRun());

    expect(withBuild.buildHash).toBe("h1");
    expect(store.findRun(withBuild.id)?.buildHash).toBe("h1");
    expect(withoutBuild).not.toHaveProperty("buildHash");
    expect(store.findRun(withoutBuild.id)).not.toHaveProperty("buildHash");
  });

  it("gives no way to edit or remove an appended event through what it returns", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());
    store.append(id, "p1", { kind: "sent" });

    const events = store.events(id);
    events.pop();
    const fresh = store.events(id);
    Object.assign(fresh[0] ?? {}, { kind: "done" });

    expect(store.events(id).map((event) => event.kind)).toEqual(["sent"]);
  });
});
