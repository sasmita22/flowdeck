import { describe, expect, it } from "vitest";
import { BuildRunningError } from "../../src/core/run/store.js";
import type { ActivityEntry } from "../../src/core/run/activity.js";
import type { BuildEvent } from "../../src/core/run/build-progress.js";
import type { NewBuild, NewPendingBuild, NewRun } from "../../src/ports/store.js";
import { FakeStore } from "./fake-store.js";

const newRun = (nodeIds = ["p1", "p2", "p3"], buildId = "b1"): NewRun => ({
  buildDir: `/fd/workspaces/${buildId}`,
  inputs: {},
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId,
});

const build = (id: string, name = `build-${id}`, hash = "h1"): NewBuild => ({
  id,
  hash,
  name,
  repo: "/repo",
  base: "main",
  values: {},
  dir: `/fd/workspaces/${id}`,
  files: [
    { path: "manifest.json", sha256: "m" },
    { path: "commands/p1.md", sha256: "c" },
  ],
  nodes: [{ nodeId: "p1", type: "prompt", config: {}, file: "commands/p1.md" }],
});

const pending = (flowId = "flow-1", name = "nightly"): NewPendingBuild => ({
  flowId,
  version: 3,
  name,
  origin: { kind: "canvas" },
  startedAt: 1_000,
});

const startedId = (store: FakeStore, build: NewPendingBuild): string => {
  const start = store.startPendingBuild(build);
  if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
  return start.pendingId;
};

describe("FakeStore", () => {
  it("creates a running run with a fresh id and finds it by id", () => {
    const store = new FakeStore();

    const first = store.createRun(newRun());
    const second = store.createRun(newRun(["p1"], "b2"));

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

  it("reopens a finished run as running", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());
    store.finishRun(id, "failed");

    store.reopenRun(id);

    expect(store.findRun(id)?.status).toBe("running");
  });

  it("keeps each run's activity in id order, an entry written again replacing the old one", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());
    const entry = {
      id: 2,
      nodeId: "p1",
      at: 1,
      kind: "tool" as const,
      tool: "Bash",
      summary: "ls",
    };

    store.recordActivity(id, entry);
    store.recordActivity(id, { ...entry, id: 1 });
    store.recordActivity(id, { ...entry, summary: "pwd" });

    expect(store.activity(id)).toEqual([
      { ...entry, id: 1 },
      { ...entry, summary: "pwd" },
    ]);
    expect(store.activity("other")).toEqual([]);
  });

  it("stamps events with the clock it is given", () => {
    const store = new FakeStore({ now: () => new Date(5000) });
    const { id } = store.createRun(newRun());

    store.append(id, "p1", { kind: "sent" });

    expect(store.events(id)[0]?.time).toBe(new Date(5000).toISOString());
  });

  it("records the status a run finished with", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun());

    store.finishRun(id, "done");

    expect(store.findRun(id)?.status).toBe("done");
  });

  it("keeps two builds of one hash under two ids and names", () => {
    const store = new FakeStore();

    store.recordBuild(build("b1", "fix-login"));
    store.recordBuild(build("b2", "fix-signup"));

    expect(store.builds()).toEqual([build("b1", "fix-login"), build("b2", "fix-signup")]);
  });

  it("lists builds newest first, finds one by id and by name, and reads its files in path order", () => {
    const store = new FakeStore();
    store.recordBuild({ ...build("b1", "fix-login"), source: { flowId: "f1", version: 2 } });
    store.recordBuild(build("b2", "fix-signup"));

    expect(store.listBuilds()).toEqual([
      expect.objectContaining({ id: "b2", hash: "h1", name: "fix-signup", createdAt: 2 }),
      expect.objectContaining({
        id: "b1",
        hash: "h1",
        name: "fix-login",
        repo: "/repo",
        base: "main",
        values: {},
        dir: "/fd/workspaces/b1",
        createdAt: 1,
        source: { flowId: "f1", version: 2 },
      }),
    ]);
    expect(store.findBuild("b1")).toEqual(store.listBuilds()[1]);
    expect(store.findBuild("h1")).toBeUndefined();
    expect(store.findBuildByName("fix-signup")).toEqual(store.listBuilds()[0]);
    expect(store.findBuildByName("nope")).toBeUndefined();
    expect(store.buildFiles("b1")).toEqual([
      { path: "commands/p1.md", sha256: "c" },
      { path: "manifest.json", sha256: "m" },
    ]);
    expect(store.buildFiles("nope")).toEqual([]);
  });

  it("keeps the build id a run was created with", () => {
    const store = new FakeStore();

    const run = store.createRun(newRun());

    expect(run.buildId).toBe("b1");
    expect(store.findRun(run.id)?.buildId).toBe("b1");
  });

  describe("mirrors the database rules", () => {
    it("refuses a second running run of a build with a BuildRunningError, keeping only the first", () => {
      const store = new FakeStore();
      const first = store.createRun(newRun());

      expect(() => store.createRun(newRun())).toThrow(BuildRunningError);
      expect(store.runs.map((run) => run.id)).toEqual([first.id]);
    });

    it("runs another build, or the same build again once its run has finished", () => {
      const store = new FakeStore();
      const first = store.createRun(newRun());

      store.createRun(newRun(["p1"], "b2"));
      store.finishRun(first.id, "done");

      expect(store.createRun(newRun()).status).toBe("running");
    });

    it("refuses to reopen a run while another run of its build is running", () => {
      const store = new FakeStore();
      const first = store.createRun(newRun());
      store.finishRun(first.id, "stopped");
      store.createRun(newRun());

      expect(() => store.reopenRun(first.id)).toThrow(BuildRunningError);
      expect(store.findRun(first.id)?.status).toBe("stopped");
    });

    it("refuses a second build with the name of one not deleted, and takes it once that one is deleted", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));

      expect(() => store.recordBuild(build("b2", "fix-login"))).toThrow();

      store.deleteBuild("b1");
      store.recordBuild(build("b3", "fix-login"));
      expect(store.findBuildByName("fix-login")).toMatchObject({ id: "b3" });
    });

    it("refuses to record a build over one with the same id", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));

      expect(() => store.recordBuild({ ...build("b1", "other"), dir: "/elsewhere" })).toThrow();
      expect(store.builds()).toEqual([build("b1", "fix-login")]);
    });

    it("refuses to delete a build twice", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1"));
      store.deleteBuild("b1");

      expect(() => store.deleteBuild("b1")).toThrow();
    });

    it("gives no way to change a build through what it returns", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));

      const found = store.findBuild("b1");
      Object.assign(found ?? {}, { name: "other", dir: "/x" });

      expect(store.findBuild("b1")).toMatchObject({ name: "fix-login", dir: "/fd/workspaces/b1" });
    });

    it("hides a deleted build and its runs from every list", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));
      store.recordBuild(build("b2", "fix-signup"));
      const gone = store.createRun(newRun(["p1"]));
      store.finishRun(gone.id, "done");
      const kept = store.createRun(newRun(["p1"], "b2"));

      store.deleteBuild("b1");

      expect(store.listBuilds().map((each) => each.id)).toEqual(["b2"]);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
      expect(store.listRuns().map((run) => run.id)).toEqual([kept.id]);
      expect(store.runs).toHaveLength(2);
    });

    it("marks an interrupted run stopped, so its build can run again, and leaves a finished one", () => {
      const store = new FakeStore();
      const interrupted = store.createRun(newRun());
      store.recordBuild(build("b2"));
      const finished = store.createRun(newRun(["p1"], "b2"));
      store.finishRun(finished.id, "done");

      store.stopRun(interrupted.id);
      store.stopRun(finished.id);

      expect(store.findRun(interrupted.id)?.status).toBe("stopped");
      expect(store.findRun(finished.id)?.status).toBe("done");
      expect(store.createRun(newRun()).status).toBe("running");
    });
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

  it("lists runs running first, then newest, with cost, end and the blueprint version built", () => {
    const store = new FakeStore();
    store.recordBuild({ ...build("b1"), source: { flowId: "flow-1", version: 2 } });
    const done = store.createRun(newRun(["p1"]));
    store.append(done.id, "p1", { kind: "done" });
    store.recordCost(done.id, 0.5);
    store.finishRun(done.id, "done");
    const running = store.createRun(newRun(["p1"]));

    expect(store.listRuns()).toEqual([
      expect.objectContaining({ id: running.id, status: "running", endedAt: null }),
      expect.objectContaining({
        id: done.id,
        status: "done",
        buildId: "b1",
        totalCost: 0.5,
        endedAt: new Date(0).toISOString(),
        nodeCount: 1,
        source: { flowId: "flow-1", version: 2 },
      }),
    ]);
  });

  describe("pending builds", () => {
    it("is busy for a second build of the same blueprint while one is open", () => {
      const store = new FakeStore();
      store.startPendingBuild(pending("flow-1", "nightly"));

      expect(store.startPendingBuild(pending("flow-1", "weekly"))).toEqual({
        kind: "busy",
        reason: "blueprint",
      });
    });

    it("finds the open build of a name, and none once it has ended", () => {
      const store = new FakeStore();
      const id = startedId(store, pending("flow-1", "nightly"));
      store.startPendingBuild(pending("flow-2", "weekly"));

      expect(store.findPendingBuildByName("nightly")).toMatchObject({ id, name: "nightly" });
      expect(store.findPendingBuildByName("monthly")).toBeUndefined();

      store.endPendingBuild(id, { outcome: "failed", endedAt: 2_000 });

      expect(store.findPendingBuildByName("nightly")).toBeUndefined();
    });

    it("is busy for a second build under the same name while one is open", () => {
      const store = new FakeStore();
      store.startPendingBuild(pending("flow-1", "nightly"));

      expect(store.startPendingBuild(pending("flow-2", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
      });
    });

    it("frees the blueprint and the name once the build ends", () => {
      const store = new FakeStore();
      const first = startedId(store, pending());
      expect(store.startPendingBuild(pending()).kind).toBe("busy");

      store.endPendingBuild(first, { outcome: "failed", endedAt: 2_000 });

      const again = store.startPendingBuild(pending());
      expect(again.kind).toBe("started");
      expect(again).not.toEqual({ kind: "started", pendingId: first });
    });

    it("returns build events in the order they were appended", () => {
      const store = new FakeStore();
      const id = startedId(store, pending());
      const events: BuildEvent[] = [
        { type: "step", step: 1, status: "running" },
        {
          type: "session",
          name: "fd-build-1",
          claudeSessionId: "c1",
          buildId: "b1",
          repo: "/repo",
          base: "main",
          values: {},
        },
        { type: "step", step: 1, status: "done" },
      ];

      for (const event of events) store.appendBuildEvent(id, event);

      const stored = store.buildEvents(id);
      expect(stored).toEqual(events.map((event) => expect.objectContaining(event)));
      const seqs = stored.map((event) => event.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(3);
    });

    it("returns build activity in the order it was appended", () => {
      const store = new FakeStore();
      const id = startedId(store, pending());
      const entries: ActivityEntry[] = [
        { id: 2, nodeId: "p1", at: 10, summary: "Read a.ts", kind: "tool", tool: "Read" },
        { id: 1, nodeId: "p1", at: 11, summary: "turn", kind: "turn" },
      ];

      for (const entry of entries) store.appendBuildActivity(id, entry);

      expect(store.buildActivity(id)).toEqual(entries);
    });

    it("lists each blueprint's latest ended build with its outcome, build id and report, never an open one", () => {
      const store = new FakeStore();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const older = startedId(store, pending("flow-1", "first"));
      store.endPendingBuild(older, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      const latest = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(latest, { outcome: "needs-you", endedAt: 3_000, report });
      const other = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(other, { outcome: "built", endedAt: 2_500, buildId: "b3" });
      startedId(store, pending("flow-1", "fourth"));
      startedId(store, pending("flow-3", "fifth"));

      expect(store.listLatestEndedPendingBuilds()).toEqual([
        expect.objectContaining({ id: other, flowId: "flow-2", outcome: "built", buildId: "b3" }),
        expect.objectContaining({
          id: latest,
          flowId: "flow-1",
          name: "second",
          outcome: "needs-you",
          endedAt: 3_000,
          report,
        }),
      ]);
    });

    it("reads one build by id: an ended one with its outcome, report and origin, an open one, and none for an unknown id", () => {
      const store = new FakeStore();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const origin = {
        source: { flowId: "flow-1", version: 3 },
        request: { values: { ticket: "FD-1" }, repo: "/repo", base: "main" },
      };
      const ended = startedId(store, { ...pending("flow-1", "asked"), origin });
      store.endPendingBuild(ended, { outcome: "needs-you", endedAt: 2_000, report });
      const going = startedId(store, pending("flow-2", "going"));

      expect(store.pendingBuild(ended)).toEqual({
        id: ended,
        flowId: "flow-1",
        version: 3,
        name: "asked",
        origin,
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: "needs-you",
        report,
      });
      expect(store.pendingBuild(going)).toEqual({
        id: going,
        flowId: "flow-2",
        version: 3,
        name: "going",
        origin: { kind: "canvas" },
        startedAt: 1_000,
      });
      expect(store.pendingBuild("missing")).toBeNull();
    });

    it("throws when a build is ended twice", () => {
      const store = new FakeStore();
      const id = startedId(store, pending());
      store.endPendingBuild(id, { outcome: "built", endedAt: 2_000, buildId: "b1" });

      expect(() => store.endPendingBuild(id, { outcome: "failed", endedAt: 3_000 })).toThrow();
    });
  });
});
