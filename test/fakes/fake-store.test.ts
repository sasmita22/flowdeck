import { describe, expect, it } from "vitest";
import type { NewBuild, NewRun } from "../../src/ports/store.js";
import { FakeStore } from "./fake-store.js";

const newRun = (nodeIds = ["p1", "p2", "p3"]): NewRun => ({
  buildDir: "/fd/builds/abc",
  inputs: { cwd: "/repo" },
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildHash: "h1",
});

const build = (hash: string): NewBuild => ({
  hash,
  dir: `/fd/builds/${hash}`,
  files: [
    { path: "manifest.json", sha256: "m" },
    { path: "commands/p1.md", sha256: "c" },
  ],
  nodes: [{ nodeId: "p1", type: "prompt", config: {}, file: "commands/p1.md" }],
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

  it("keeps the first record of a hash however often it is recorded", () => {
    const store = new FakeStore();

    store.recordBuild(build("h1"));
    store.recordBuild({ ...build("h1"), dir: "/elsewhere" });

    expect(store.builds()).toEqual([build("h1")]);
  });

  it("lists builds newest first, finds one by hash, and reads its files in path order", () => {
    const store = new FakeStore();
    store.recordBuild({ ...build("h1"), source: { flowId: "f1", version: 2 } });
    store.recordBuild(build("h2"));

    expect(store.listBuilds()).toEqual([
      { hash: "h2", dir: "/fd/builds/h2", createdAt: 2 },
      { hash: "h1", dir: "/fd/builds/h1", createdAt: 1, source: { flowId: "f1", version: 2 } },
    ]);
    expect(store.findBuild("h1")).toEqual(store.listBuilds()[1]);
    expect(store.findBuild("nope")).toBeUndefined();
    expect(store.buildFiles("h1")).toEqual([
      { path: "commands/p1.md", sha256: "c" },
      { path: "manifest.json", sha256: "m" },
    ]);
    expect(store.buildFiles("nope")).toEqual([]);
  });

  it("keeps the build hash a run was created with", () => {
    const store = new FakeStore();

    const run = store.createRun(newRun());

    expect(run.buildHash).toBe("h1");
    expect(store.findRun(run.id)?.buildHash).toBe("h1");
  });

  it("keeps the total cost written for a run", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());

    store.recordCost(id, 0.5);

    expect(store.costOf(id)).toBe(0.5);
    expect(store.costOf("nope")).toBeUndefined();
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
