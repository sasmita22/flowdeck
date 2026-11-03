import { describe, expect, it } from "vitest";
import { createPublishingStore } from "../../../src/app/engine/publishing-store.js";
import { runSnapshot } from "../../../src/core/run/snapshot.js";
import type { NewBuild, NewRun } from "../../../src/ports/store.js";
import { FakeStore } from "../../fakes/fake-store.js";

const nodeIds = ["p1", "p2"];

const newRun = (buildId = "b0"): NewRun => ({
  buildDir: `/fd/workspaces/${buildId}`,
  inputs: {},
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId,
});

const build: NewBuild = {
  id: "b1",
  hash: "h1",
  name: "fix-login",
  repo: "/repo",
  base: "main",
  values: {},
  dir: "/fd/workspaces/b1",
  files: [{ path: "manifest.json", sha256: "m" }],
  nodes: [],
};

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

  it("publishes a running snapshot when a finished run is reopened", () => {
    const { inner, runId, pushes, store, expected } = setup();
    store.finishRun(runId, "failed");

    store.reopenRun(runId);

    expect(inner.findRun(runId)?.status).toBe("running");
    expect(pushes.at(-1)).toEqual(expected("running"));
  });

  it("delegates the other methods to the inner store and publishes nothing for them", () => {
    const { inner, runId, pushes, store } = setup();

    const created = store.createRun(newRun("b1"));
    store.recordBuild(build);
    store.recordCost(runId, 0.25);
    const entry = {
      id: 1,
      nodeId: "p1",
      at: 1,
      kind: "tool" as const,
      tool: "Bash",
      summary: "ls",
    };
    store.recordActivity(runId, entry);
    const found = store.findRun(runId);
    const events = store.events(runId);

    expect(pushes).toEqual([]);
    expect(inner.runs.map((run) => run.id)).toEqual([runId, created.id]);
    expect(inner.builds()).toEqual([build]);
    expect(inner.costOf(runId)).toBe(0.25);
    expect(store.listBuilds()).toEqual(inner.listBuilds());
    expect(store.findBuild("b1")).toEqual(inner.findBuild("b1"));
    expect(store.findBuildByName("fix-login")).toEqual(inner.findBuildByName("fix-login"));
    expect(store.findBuildByName("fix-login")).toMatchObject({ id: "b1" });
    expect(store.buildFiles("b1")).toEqual(inner.buildFiles("b1"));
    expect(store.listRuns()).toEqual(inner.listRuns());
    expect(found).toEqual(inner.findRun(runId));
    expect(events).toEqual(inner.events(runId));
    expect(store.activity(runId)).toEqual([entry]);
    expect(inner.activity(runId)).toEqual([entry]);
  });

  it("deletes a build through the inner store, publishing no run state", () => {
    const { inner, pushes, store } = setup();
    inner.recordBuild(build);

    store.deleteBuild("b1");

    expect(inner.listBuilds()).toEqual([]);
    expect(inner.findBuildByName("fix-login")).toBeUndefined();
    expect(pushes).toEqual([]);
  });

  it("stops an interrupted run of another build through the inner store, publishing nothing for it", () => {
    const { inner, pushes, store } = setup();
    const other = inner.createRun(newRun("b1"));

    store.stopRun(other.id);

    expect(inner.findRun(other.id)?.status).toBe("stopped");
    expect(pushes).toEqual([]);
  });

  it("publishes a stopped snapshot when its own run is stopped", () => {
    const { inner, runId, pushes, store, expected } = setup();

    store.stopRun(runId);

    expect(inner.findRun(runId)?.status).toBe("stopped");
    expect(pushes).toEqual([expected("stopped")]);
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
