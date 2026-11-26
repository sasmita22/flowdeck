import { describe, expect, it } from "vitest";
import { flowSvg } from "../../src/core/flow/flow-svg.js";
import {
  BuildRunningError,
  type NewBuildSnapshot,
  type RunStory,
} from "../../src/core/run/store.js";
import type { ActivityEntry } from "../../src/core/run/activity.js";
import type { BuildEvent } from "../../src/core/run/build-progress.js";
import type { RepoState } from "../../src/core/run/repo-state.js";
import type { NewBuild, NewPendingBuild, NewRun } from "../../src/ports/store.js";
import { agent, flow } from "../fixtures/flow-builders.js";
import { FakeStore } from "./fake-store.js";

const newRun = (nodeIds = ["p1", "p2", "p3"], buildId = "b1"): NewRun => ({
  buildDir: `/fd/workspaces/${buildId}`,
  inputs: {},
  nodeIds,
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId,
});

const lockedManifest = '{\n  "version": 1,\n  "hash": "h1",\n  "nodes": []\n}\n';

const lockedBeforeManifests = (
  id: string,
  name = `build-${id}`,
  hash = "h1",
): Omit<NewBuild, "manifest"> => ({
  id,
  hash,
  name,
  repo: "/repo",
  base: "main",
  branch: `flowdeck/${name}`,
  branchCreated: true,
  values: {},
  dir: `/fd/workspaces/${id}`,
  files: [
    { path: "manifest.json", sha256: "m" },
    { path: "commands/p1.md", sha256: "c" },
  ],
  nodes: [{ nodeId: "p1", type: "prompt", config: {}, file: "commands/p1.md" }],
});

const build = (id: string, name?: string, hash?: string): NewBuild => ({
  ...lockedBeforeManifests(id, name, hash),
  manifest: lockedManifest,
});

const pending = (flowId = "flow-1", name = "nightly"): NewPendingBuild => ({
  flowId,
  version: 3,
  name,
  origin: { kind: "canvas" },
  startedAt: 1_000,
});

const savedFlow = flow([agent("a1")], []);

const snapshot = (blueprintName: string): NewBuildSnapshot => ({
  blueprintName,
  version: 3,
  svg: flowSvg(savedFlow),
});

const startedId = (store: FakeStore, build: NewPendingBuild): string => {
  const start = store.startPendingBuild(build);
  if (start.kind !== "started") throw new Error(`expected a start, got ${start.reason}`);
  return start.pendingId;
};

describe("FakeStore", () => {
  it("creates a running run with a fresh id and finds it by id", () => {
    const store = new FakeStore();

    store.recordBuild(build("b1", "fix-login"));
    const first = store.createRun(newRun());
    const second = store.createRun(newRun(["p1"], "b2"));

    expect(first.id).not.toBe(second.id);
    expect(first).toEqual({
      ...newRun(),
      id: first.id,
      status: "running",
      buildName: "fix-login",
      buildHash: "h1",
      blueprintName: null,
      repo: "/repo",
      branch: "flowdeck/fix-login",
      buildValues: {},
      manifestJson: lockedManifest,
    });
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

  describe("with session containers", () => {
    const web = {
      tmuxName: "fd-run-0000000a",
      cwd: "/fd/workspaces/b1/sessions/web/web",
      claudeSessionId: "c2",
    };
    const api = {
      tmuxName: "fd-run-0000000b",
      cwd: "/fd/workspaces/b1/sessions/api/api",
      claudeSessionId: "c3",
    };

    it("stores each container's session under the workspace session, workspace first", () => {
      const store = new FakeStore();

      const { id } = store.createRun({ ...newRun(), sessions: [web, api] });
      store.createRun({
        ...newRun(["p1"], "b2"),
        sessions: [{ ...web, claudeSessionId: "x" }],
      });

      expect(store.runSessions(id)).toEqual([
        { ...newRun().session, parent: null },
        { ...web, parent: "c1" },
        { ...api, parent: "c1" },
      ]);
      expect(store.findRun(id)?.session).toEqual(newRun().session);
    });

    it("records each node under the session that names it, and every other node under the workspace session", () => {
      const store = new FakeStore();

      const { id } = store.createRun({
        ...newRun(["w1", "a1", "a2", "b1"]),
        sessions: [
          { ...web, nodeIds: ["a1", "a2"] },
          { ...api, nodeIds: ["b1"] },
        ],
      });
      store.createRun({
        ...newRun(["a1"], "b2"),
        sessions: [{ ...web, claudeSessionId: "x", nodeIds: ["a1"] }],
      });

      expect(store.nodeSessions(id)).toEqual({ w1: "c1", a1: "c2", a2: "c2", b1: "c3" });
      expect(store.findRun(id)?.nodeIds).toEqual(["w1", "a1", "a2", "b1"]);
    });

    it("records every node under the workspace session when no session names one, and none for an unknown run", () => {
      const store = new FakeStore();

      const { id } = store.createRun({ ...newRun(), sessions: [web] });

      expect(store.nodeSessions(id)).toEqual({ p1: "c1", p2: "c1", p3: "c1" });
      expect(store.nodeSessions("nope")).toEqual({});
    });

    it("reads only the workspace session of a run made without them, and none for an unknown run", () => {
      const store = new FakeStore();

      const { id } = store.createRun(newRun());

      expect(store.runSessions(id)).toEqual([{ ...newRun().session, parent: null }]);
      expect(store.runSessions("nope")).toEqual([]);
    });
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

    it("removes the build's step texts and the older ended attempts of its name, keeping its runs", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));
      const older = startedId(store, { ...pending("flow-1", "fix-login"), startedAt: 100 });
      store.endPendingBuild(older, { outcome: "failed", endedAt: 200 });
      const other = startedId(store, { ...pending("flow-1", "nightly"), startedAt: 100 });
      store.endPendingBuild(other, { outcome: "failed", endedAt: 200 });
      const built = startedId(store, pending("flow-1", "fix-login"));
      store.appendBuildStepText(built, 1, "output", "full");
      store.endPendingBuild(built, { outcome: "built", endedAt: 2_000, buildId: "b1" });
      const run = store.createRun(newRun(["p1"]));
      store.finishRun(run.id, "done");

      store.deleteBuild("b1");

      expect(store.buildStepTexts(built, 1)).toEqual([]);
      expect(store.pendingBuild(older)).toBeNull();
      expect(store.pendingBuild(other)).toMatchObject({ id: other });
      expect(store.findRun(run.id)).toMatchObject({ id: run.id, buildId: "b1" });
    });

    it("deletes a build twice without an error", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1"));
      store.deleteBuild("b1");

      expect(() => store.deleteBuild("b1")).not.toThrow();
    });

    it("gives no way to change a build through what it returns", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));

      const found = store.findBuild("b1");
      Object.assign(found ?? {}, { name: "other", dir: "/x" });

      expect(store.findBuild("b1")).toMatchObject({ name: "fix-login", dir: "/fd/workspaces/b1" });
    });

    it("hides a deleted build from every list, keeping its runs listed, marked deleted", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1", "fix-login"));
      store.recordBuild(build("b2", "fix-signup"));
      const gone = store.createRun(newRun(["p1"]));
      store.finishRun(gone.id, "done");
      const kept = store.createRun(newRun(["p1"], "b2"));

      store.deleteBuild("b1");

      expect(store.listBuilds().map((each) => each.id)).toEqual(["b2"]);
      expect(store.findBuildByName("fix-login")).toBeUndefined();
      expect(store.listRuns().map(({ id, buildGone }) => ({ id, buildGone }))).toEqual([
        { id: kept.id, buildGone: false },
        { id: gone.id, buildGone: true },
      ]);
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

    it("refuses to lock a pending build onto a build id that already has a snapshot, leaving the build open", () => {
      const store = new FakeStore();
      const first = startedId(store, { ...pending(), snapshot: snapshot("First") });
      store.endPendingBuild(first, { outcome: "built", endedAt: 1_000, buildId: "b1" });
      const id = startedId(store, { ...pending(), snapshot: snapshot("Second") });

      expect(() =>
        store.endPendingBuild(id, { outcome: "built", endedAt: 2_000, buildId: "b1" }),
      ).toThrow();
      expect(store.buildSnapshot({ buildId: "b1" })).toMatchObject({
        blueprintName: "First",
        pendingId: first,
      });
      expect(store.buildSnapshot({ pendingId: id })).toMatchObject({ buildId: null });
      expect(store.pendingBuild(id)?.endedAt).toBeUndefined();
    });
  });

  describe("build worktrees", () => {
    const android = {
      container: "android",
      repo: "/repos/android",
      base: "main",
      branch: "fix-login-android",
      branchCreated: true,
      path: "/fd/workspaces/b1/sessions/android/android",
    };
    const ios = {
      container: "ios",
      repo: "/repos/ios",
      base: "develop",
      branch: "fix-login-ios",
      branchCreated: true,
      path: "/fd/workspaces/b1/sessions/ios/ios",
    };
    const existingBranch = {
      container: "main",
      repo: "/repo",
      base: "main",
      branch: "feature/signup",
      branchCreated: false,
      path: "/fd/workspaces/b2/sessions/main/repo",
    };

    it("lists every worktree added for a build, in the order added", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1"));

      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);

      expect(store.buildWorktrees("b1")).toEqual([android, ios]);
    });

    it("removes a build's worktrees with the build, keeping another build's", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1"));
      store.recordBuild(build("b2"));
      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);
      store.addBuildWorktree("b2", existingBranch);

      store.deleteBuild("b1");

      expect(store.buildWorktrees("b1")).toEqual([]);
      expect(store.buildWorktrees("b2")).toEqual([existingBranch]);
    });

    it("removes the worktrees of a build that was never recorded when its pending build is deleted, keeping another build's", () => {
      const store = new FakeStore();
      store.addBuildWorktree("b2", existingBranch);
      const gone = startedId(store, pending("flow-1", "nightly"));
      store.appendBuildEvent(gone, {
        type: "session",
        name: "fd-build-nightly",
        claudeSessionId: "claude-1",
        buildId: "b1",
        repo: "",
        base: "",
        values: {},
      });
      store.addBuildWorktree("b1", android);
      store.addBuildWorktree("b1", ios);
      store.endPendingBuild(gone, { outcome: "failed", endedAt: 2_000 });

      store.deletePendingBuild(gone);

      expect(store.buildWorktrees("b1")).toEqual([]);
      expect(store.buildWorktrees("b2")).toEqual([existingBranch]);
    });
  });

  describe("build manifests", () => {
    it("keeps the manifest text a build is recorded with, unchanged, and none for an unknown build", () => {
      const store = new FakeStore();

      store.recordBuild(build("b1"));

      expect(store.buildManifest("b1")).toBe(lockedManifest);
      expect(store.buildManifest("nope")).toBeUndefined();
    });

    it("reads no manifest once the build is deleted", () => {
      const store = new FakeStore();
      store.recordBuild(build("b1"));

      store.deleteBuild("b1");

      expect(store.buildManifest("b1")).toBeUndefined();
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
      expect.objectContaining({
        id: running.id,
        status: "running",
        endedAt: null,
        buildGone: false,
        number: 2,
        doneCount: 0,
      }),
      expect.objectContaining({
        id: done.id,
        status: "done",
        buildId: "b1",
        totalCost: 0.5,
        endedAt: new Date(0).toISOString(),
        nodeCount: 1,
        source: { flowId: "flow-1", version: 2 },
        buildGone: false,
        number: 1,
        doneCount: 1,
      }),
    ]);
  });

  it("numbers each build's runs from 1 in the order they were made", () => {
    const store = new FakeStore();
    store.recordBuild(build("b1", "fix-login"));
    store.recordBuild(build("b2", "fix-signup"));
    const made: { id: string; buildId: string }[] = [];
    for (const buildId of ["b1", "b2", "b1", "b2", "b1"]) {
      const run = store.createRun(newRun(["p1"], buildId));
      store.finishRun(run.id, "done");
      made.push({ id: run.id, buildId });
    }

    const numberOf = new Map(store.listRuns().map((run) => [run.id, run.number]));

    expect(made.map(({ id, buildId }) => [buildId, numberOf.get(id)])).toEqual([
      ["b1", 1],
      ["b2", 1],
      ["b1", 2],
      ["b2", 2],
      ["b1", 3],
    ]);
  });

  it("gives one run its number among all its build's runs", () => {
    const store = new FakeStore();
    store.recordBuild(build("b1", "fix-login"));
    store.recordBuild(build("b2", "fix-signup"));
    for (const buildId of ["b1", "b2", "b1"]) {
      store.finishRun(store.createRun(newRun(["p1"], buildId)).id, "done");
    }
    const third = store.createRun(newRun(["p1"]));

    expect(store.findRunSummary(third.id)).toMatchObject({ number: 3 });
  });

  it("counts only the nodes whose latest state is done", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun(["done", "failed", "skipped", "reset", "untouched"]));
    store.append(id, "done", { kind: "running" });
    store.append(id, "done", { kind: "done" });
    store.append(id, "done", { kind: "usage", payload: { messages: [] }, tokens: 1, cost: 0.01 });
    store.append(id, "failed", { kind: "running" });
    store.append(id, "failed", { kind: "failed", payload: { message: "exit code 1" } });
    store.append(id, "skipped", { kind: "skipped" });
    store.append(id, "reset", { kind: "done" });
    store.append(id, "reset", { kind: "reset" });

    expect(store.listRuns()).toEqual([expect.objectContaining({ id, doneCount: 1, nodeCount: 5 })]);
  });

  it("counts no done nodes for a run with no events", () => {
    const store = new FakeStore();
    const { id } = store.createRun(newRun(["p1", "p2"]));

    expect(store.findRunSummary(id)).toMatchObject({ doneCount: 0, nodeCount: 2 });
  });

  it("summarises one run as listRuns does, and nothing for an unknown id", () => {
    const store = new FakeStore();
    store.recordBuild({ ...build("b1"), source: { flowId: "flow-1", version: 2 } });
    const done = store.createRun(newRun(["p1"]));
    store.append(done.id, "p1", { kind: "done" });
    store.recordCost(done.id, 0.5);
    store.finishRun(done.id, "done");
    store.createRun(newRun(["p1"]));

    expect(store.findRunSummary(done.id)).toEqual(
      store.listRuns().find((run) => run.id === done.id),
    );
    expect(store.findRunSummary("nope")).toBeUndefined();
  });

  describe("repo states", () => {
    const state = (head: string): Extract<RepoState, { kind: "read" }> => ({
      kind: "read",
      branch: "flowdeck/fix-login",
      head,
      upstream: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });

    it("reads the first before, the latest after and that after's other repos", () => {
      const store = new FakeStore();
      const { id } = store.createRun(newRun(["p1"]));

      store.appendRepoState(id, "before", state("b1"), []);
      store.appendRepoState(id, "after", state("a1"), [{ path: "/x/web", branch: "dev" }]);
      store.appendRepoState(id, "before", state("b2"), []);
      store.appendRepoState(id, "after", state("a2"), [{ path: "/x/ios", branch: "develop" }]);
      store.appendRepoState("other", "after", state("o1"), []);

      expect(store.repoStates(id)).toEqual({
        before: state("b1"),
        after: state("a2"),
        otherRepos: [{ path: "/x/ios", branch: "develop" }],
      });
      expect(store.repoStates("nope")).toEqual({ before: null, after: null, otherRepos: [] });
    });

    it("keeps another repo's before out of the run's own, and lists it merged with the after of the same repo, sorted by path", () => {
      const store = new FakeStore();
      const { id } = store.createRun(newRun(["p1"]));
      const web = { ...state("w1"), branch: "dev" };

      store.appendOtherRepoBefore(id, "/x/web", web);
      store.appendRepoState(id, "before", state("b1"), []);
      store.appendOtherRepoBefore(id, "/x/web", state("w2"));
      store.appendOtherRepoBefore(id, "/x/api", { ...state("p1"), branch: null });
      store.appendOtherRepoBefore(id, "/x/old", { kind: "unreadable" });
      store.appendRepoState(id, "after", state("a1"), [
        { path: "/x/web", branch: "dev", after: state("w3") },
        { path: "/x/ios", branch: "develop" },
      ]);

      expect(store.repoStates(id)).toEqual({
        before: state("b1"),
        after: state("a1"),
        otherRepos: [
          { path: "/x/api", branch: "detached p1", before: { ...state("p1"), branch: null } },
          { path: "/x/ios", branch: "develop" },
          { path: "/x/old", branch: "not recorded", before: { kind: "unreadable" } },
          { path: "/x/web", branch: "dev", before: web, after: state("w3") },
        ],
      });
    });
  });

  describe("build step texts", () => {
    it("reads back the latest text per field of one entry in the order they were written", () => {
      const store = new FakeStore();
      const id = startedId(store, pending());

      store.appendBuildStepText(id, 1, "output", "old output");
      store.appendBuildStepText(id, 1, "input", "input");
      store.appendBuildStepText(id, 1, "output", "new output");
      store.appendBuildStepText(id, 2, "report", "another entry");

      expect(store.buildStepTexts(id, 1)).toEqual([
        { field: "input", text: "input" },
        { field: "output", text: "new output" },
      ]);
      expect(store.buildStepTexts(id, 2)).toEqual([{ field: "report", text: "another entry" }]);
      expect(store.buildStepTexts("nope", 1)).toEqual([]);
    });
  });

  describe("step texts", () => {
    it("reads the latest text per field of one entry, and nothing for an unknown run or entry", () => {
      const store = new FakeStore();
      const { id } = store.createRun(newRun(["p1"]));

      store.appendStepText(id, 1, "input", "old input");
      store.appendStepText(id, 1, "output", "output");
      store.appendStepText(id, 1, "input", "new input");
      store.appendStepText(id, 2, "report", "another entry");

      expect(store.stepTexts(id, 1)).toEqual([
        { field: "input", text: "new input" },
        { field: "output", text: "output" },
      ]);
      expect(store.stepTexts(id, 2)).toEqual([{ field: "report", text: "another entry" }]);
      expect(store.stepTexts("nope", 1)).toEqual([]);
      expect(store.stepTexts(id, 9)).toEqual([]);
    });
  });

  describe("run stories", () => {
    const story = (runId: string, text: string, runStatus: RunStory["runStatus"] = "failed") => ({
      runId,
      at: "2026-11-15T10:00:00.000Z",
      runStatus,
      text,
      cost: 0.0007,
    });

    it("reads back the latest story of a run, the second append for it being the latest", () => {
      const store = new FakeStore();
      const { id } = store.createRun(newRun(["p1"]));
      store.finishRun(id, "failed");
      const other = store.createRun(newRun(["p1"]));
      const first = story(id, "The run failed at Test.");
      const second = { ...story(id, "Resumed, the run finished.", "done"), cost: 0.0009 };

      store.appendRunStory(first);
      expect(store.latestRunStory(id)).toEqual(first);

      store.appendRunStory(second);
      expect(store.latestRunStory(id)).toEqual(second);
      expect(store.latestRunStory(other.id)).toBeUndefined();
    });

    it("lists a run with the first non-empty line of its latest story, and one without a story with none", () => {
      const store = new FakeStore();
      const told = store.createRun(newRun(["p1"]));
      store.finishRun(told.id, "failed");
      const untold = store.createRun(newRun(["p1"]));
      store.finishRun(untold.id, "done");
      store.appendRunStory(story(told.id, "Old account.\nStill old."));
      store.appendRunStory(story(told.id, "\nThe run failed at Test.\nThe suite did not pass."));

      const listed = new Map(store.listRuns().map((run) => [run.id, run]));

      expect(listed.get(told.id)?.storyLine).toBe("The run failed at Test.");
      expect(store.findRunSummary(told.id)?.storyLine).toBe("The run failed at Test.");
      expect(listed.get(untold.id)).not.toHaveProperty("storyLine");
      expect(store.findRunSummary(untold.id)).not.toHaveProperty("storyLine");
    });
  });

  it("finds a run of a deleted build, marked deleted, as listRuns lists it", () => {
    const store = new FakeStore();
    store.recordBuild(build("b1", "fix-login"));
    const gone = store.createRun(newRun(["p1"]));
    store.finishRun(gone.id, "failed");

    store.deleteBuild("b1");

    expect(store.findRunSummary(gone.id)).toMatchObject({
      id: gone.id,
      status: "failed",
      buildId: "b1",
      buildName: "fix-login",
      nodeCount: 1,
      buildGone: true,
    });
    expect(store.listRuns()).toEqual([store.findRunSummary(gone.id)]);
  });

  describe("deleting a run", () => {
    const threeFinishedRuns = (store: FakeStore): [string, string, string] => {
      const finished = () => {
        const run = store.createRun(newRun(["p1"]));
        store.finishRun(run.id, "done");
        return run.id;
      };
      return [finished(), finished(), finished()];
    };

    it("removes the run and every row of it, hiding it from listRuns and keeping the others", () => {
      const store = new FakeStore();
      const [first, second] = threeFinishedRuns(store);
      for (const id of [first, second]) {
        store.append(id, "p1", { kind: "sent" });
        store.recordActivity(id, {
          id: 1,
          nodeId: "p1",
          at: 1,
          kind: "tool",
          tool: "Bash",
          summary: "ls",
        });
        store.appendRunStory({ runId: id, at: "t", runStatus: "done", text: "Told.", cost: 0 });
        store.appendRepoState(id, "before", { kind: "unreadable" }, []);
        store.appendOtherRepoBefore(id, "/x/web", { kind: "unreadable" });
        store.appendStepText(id, 1, "output", "full");
      }

      store.deleteRun(second);

      expect(store.listRuns().map((run) => run.id)).not.toContain(second);
      expect(store.listRuns().map((run) => run.id)).toContain(first);
      expect(store.runs).toHaveLength(2);
      expect(store.nodes.filter((node) => node.runId === second)).toEqual([]);
      expect(store.events(second)).toEqual([]);
      expect(store.activity(second)).toEqual([]);
      expect(store.latestRunStory(second)).toBeUndefined();
      expect(store.repoStates(second)).toEqual({ before: null, after: null, otherRepos: [] });
      expect(store.stepTexts(second, 1)).toEqual([]);
      expect(store.events(first)).toHaveLength(1);
      expect(store.repoStates(first).otherRepos).toHaveLength(1);
    });

    it("keeps the numbers of the build's other runs", () => {
      const store = new FakeStore();
      const [first, second, third] = threeFinishedRuns(store);

      store.deleteRun(second);

      const numberOf = new Map(store.listRuns().map((run) => [run.id, run.number]));
      expect([numberOf.get(first), numberOf.get(third)]).toEqual([1, 3]);
    });

    it("finds nothing for the deleted run by id", () => {
      const store = new FakeStore();
      const [, second] = threeFinishedRuns(store);

      store.deleteRun(second);

      expect(store.findRun(second)).toBeUndefined();
      expect(store.findRunSummary(second)).toBeUndefined();
    });

    it("never gives a deleted top run's number to the build's next run", () => {
      const store = new FakeStore();
      const [, , third] = threeFinishedRuns(store);
      store.deleteRun(third);

      const next = store.createRun(newRun(["p1"]));

      expect(store.findRunSummary(next.id)).toMatchObject({ number: 4 });
    });

    it("summarises a run that is not deleted as listRuns does", () => {
      const store = new FakeStore();
      const [first, second, third] = threeFinishedRuns(store);

      store.deleteRun(second);

      for (const id of [first, third]) {
        expect(store.findRunSummary(id)).toEqual(store.listRuns().find((run) => run.id === id));
      }
    });

    it("does nothing when the run is deleted again", () => {
      const store = new FakeStore();
      const [, second] = threeFinishedRuns(store);
      store.deleteRun(second);
      const listed = store.listRuns();

      store.deleteRun(second);

      expect(store.listRuns()).toEqual(listed);
      expect(store.findRunSummary(second)).toBeUndefined();
    });
  });

  describe("deleting a pending build", () => {
    it("removes an open build and every row of it, hiding it from listPendingBuilds", () => {
      const store = new FakeStore();
      const gone = startedId(store, {
        ...pending("flow-1", "nightly"),
        snapshot: snapshot("Nightly"),
      });
      const kept = startedId(store, pending("flow-2", "weekly"));
      for (const id of [gone, kept]) {
        store.appendBuildEvent(id, { type: "step", step: 1, status: "running" });
        store.appendBuildActivity(id, {
          id: 1,
          nodeId: "p1",
          at: 1,
          kind: "tool",
          tool: "Bash",
          summary: "ls",
        });
        store.appendBuildStepText(id, 1, "output", "full");
      }

      store.deletePendingBuild(gone);

      expect(store.listPendingBuilds().map((each) => each.id)).toEqual([kept]);
      expect(store.pendingBuild(gone)).toBeNull();
      expect(store.buildEvents(gone)).toEqual([]);
      expect(store.buildActivity(gone)).toEqual([]);
      expect(store.buildStepTexts(gone, 1)).toEqual([]);
      expect(store.buildSnapshot({ pendingId: gone })).toBeNull();
      expect(store.buildEvents(kept)).toHaveLength(1);
      expect(store.buildStepTexts(kept, 1)).toEqual([{ field: "output", text: "full" }]);
    });

    it("hides an ended build from listLatestEndedPendingBuildsByName", () => {
      const store = new FakeStore();
      const gone = startedId(store, pending("flow-1", "first"));
      store.endPendingBuild(gone, { outcome: "failed", endedAt: 2_000 });
      const kept = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(kept, { outcome: "failed", endedAt: 3_000 });

      store.deletePendingBuild(gone);

      expect(store.listLatestEndedPendingBuildsByName().map((each) => each.id)).toEqual([kept]);
    });

    it("does not bring back an older ended build of the name once the latest is hidden", () => {
      const store = new FakeStore();
      const older = startedId(store, pending("flow-1", "nightly"));
      store.endPendingBuild(older, { outcome: "failed", endedAt: 2_000 });
      const latest = startedId(store, pending("flow-1", "nightly"));
      store.endPendingBuild(latest, { outcome: "needs-you", endedAt: 3_000 });

      store.deletePendingBuild(latest);

      expect(store.listLatestEndedPendingBuildsByName()).toEqual([]);
      expect(store.pendingBuild(older)).toBeNull();
    });

    it("leaves a going build of the name, started earlier, as it is", () => {
      const store = new FakeStore();
      const older = startedId(store, { ...pending("flow-1", "nightly"), startedAt: 100 });
      store.endPendingBuild(older, { outcome: "failed", endedAt: 200 });
      const latest = startedId(store, pending("flow-1", "nightly"));
      store.endPendingBuild(latest, { outcome: "failed", endedAt: 2_000 });
      const going = startedId(store, { ...pending("flow-1", "nightly"), startedAt: 500 });

      store.deletePendingBuild(latest);

      expect(store.pendingBuild(older)).toBeNull();
      expect(store.listPendingBuilds().map((each) => each.id)).toEqual([going]);
    });

    it("leaves a deleted pending build as it is when it is deleted again", () => {
      const store = new FakeStore();
      const id = startedId(store, pending());
      store.endPendingBuild(id, { outcome: "failed", endedAt: 2_000 });
      store.deletePendingBuild(id);

      store.deletePendingBuild(id);

      expect(store.listLatestEndedPendingBuildsByName()).toEqual([]);
      expect(store.pendingBuild(id)).toBeNull();
    });
  });

  describe("pending builds", () => {
    it("starts a second build of the same blueprint under another name while one is open", () => {
      const store = new FakeStore();
      const first = startedId(store, pending("flow-1", "nightly"));

      const second = store.startPendingBuild(pending("flow-1", "weekly"));

      expect(second).toEqual({ kind: "started", pendingId: expect.any(String) });
      expect(second).not.toEqual({ kind: "started", pendingId: first });
    });

    it("reports the name when a blueprint with an open build is built again under a taken name", () => {
      const store = new FakeStore();
      store.startPendingBuild(pending("flow-1", "weekly"));
      store.startPendingBuild(pending("flow-2", "nightly"));

      expect(store.startPendingBuild(pending("flow-1", "nightly"))).toEqual({
        kind: "busy",
        reason: "name",
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

    it("frees the name once the build ends", () => {
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

    it("lists each name's latest ended build with its outcome and report, dropping a name that ended built, never an open one", () => {
      const store = new FakeStore();
      const report = { version: 1, questions: [{ nodeId: "a1", text: "Which repo?" }] };
      const first = startedId(store, pending("flow-1", "first"));
      store.endPendingBuild(first, { outcome: "failed", endedAt: 2_000 });
      const second = startedId(store, pending("flow-1", "second"));
      store.endPendingBuild(second, { outcome: "needs-you", endedAt: 3_000, report });
      const olderThird = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(olderThird, { outcome: "failed", endedAt: 2_200 });
      const third = startedId(store, pending("flow-2", "third"));
      store.endPendingBuild(third, { outcome: "built", endedAt: 2_500, buildId: "b3" });
      startedId(store, pending("flow-1", "fourth"));
      startedId(store, pending("flow-3", "fifth"));

      expect(store.listLatestEndedPendingBuildsByName()).toEqual([
        expect.objectContaining({ id: first, flowId: "flow-1", name: "first", outcome: "failed" }),
        expect.objectContaining({
          id: second,
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
