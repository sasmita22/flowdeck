import { beforeEach, describe, expect, it } from "vitest";
import {
  createActivityTracker,
  createBuildActivity,
} from "../../../src/app/engine/activity-tracker.js";
import type { EnginePush } from "../../../src/app/engine/protocol.js";
import { previewOf, type ActivityEntry } from "../../../src/core/run/activity.js";
import type { BuildStepEvent } from "../../../src/ports/build-agents.js";
import type { Store } from "../../../src/ports/store.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeStore } from "../../fakes/fake-store.js";

const session = "s1";

describe("createActivityTracker", () => {
  let clock: number;
  let pushes: EnginePush[];
  let logs: string[];
  let publish: (push: EnginePush) => void;
  let inner: FakeStore;
  let rows: ActivityEntry[];
  let texts: unknown[][];
  let runId: string;
  let store: Store;
  let source: FakeEventSource;
  let unwatch: () => void;

  const hook = (
    kind: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStop",
    at: number,
    fields: Record<string, unknown> = {},
    sessionId = session,
  ) =>
    source.publish({
      kind,
      sessionId,
      payload: { hook_event_name: kind, session_id: sessionId, flowdeck_hook_at: at, ...fields },
    });

  const bash = (at: number, sessionId = session) =>
    hook("PreToolUse", at, { tool_name: "Bash", tool_input: { command: "ls" } }, sessionId);

  const agent = (at: number) =>
    hook("PreToolUse", at, {
      tool_name: "Agent",
      tool_input: { description: "Look" },
      tool_use_id: "toolu_1",
    });

  const agentDone = (at: number) =>
    hook("PostToolUse", at, {
      tool_name: "Agent",
      tool_input: { description: "Look" },
      tool_use_id: "toolu_1",
      tool_response: { status: "completed", agentId: "agent-1", agentType: "general-purpose" },
    });

  const activity = () => pushes.filter((push) => push.push === "activity");

  beforeEach(() => {
    clock = 0;
    pushes = [];
    logs = [];
    publish = (push) => pushes.push(push);
    inner = new FakeStore();
    rows = [];
    texts = [];
    runId = inner.createRun({
      buildDir: "/fd-home/builds/b1",
      inputs: {},
      nodeIds: ["p1", "p2"],
      session: { tmuxName: "fd-run-test", cwd: "/repo", claudeSessionId: session },
      buildId: "b1",
    }).id;
    const tracker = createActivityTracker({
      runId,
      now: () => clock,
      publish: (push) => publish(push),
      log: (line) => logs.push(line),
      activity: {
        recordActivity: (id, entry) => {
          rows.push(entry);
          inner.recordActivity(id, entry);
        },
        activity: (id) => inner.activity(id),
        appendStepText: (...call) => {
          texts.push(call);
          inner.appendStepText(...call);
        },
      },
      turnNodes: new Set(["p2"]),
      place: { cwd: "/repo", home: "/Users/me" },
    });
    store = tracker.store(inner);
    clock = 100;
    store.append(runId, "p1", { kind: "sent" });
    clock = 200;
    store.append(runId, "p1", { kind: "done" });
    clock = 300;
    store.appendAll(runId, [{ nodeId: "p2", event: { kind: "sent" } }]);
    source = new FakeEventSource();
    unwatch = tracker.watch(source, session);
  });

  it("passes every append through to the inner store unchanged", () => {
    expect(inner.events(runId).map(({ nodeId, kind }) => ({ nodeId, kind }))).toEqual([
      { nodeId: "p1", kind: "sent" },
      { nodeId: "p1", kind: "done" },
      { nodeId: "p2", kind: "sent" },
    ]);
  });

  it("forwards the rest of the store to the inner store", () => {
    store.finishRun(runId, "done");
    const build = {
      id: "h1",
      hash: "h1",
      name: "b1",
      repo: "/repo",
      base: "main",
      branch: "flowdeck/b1",
      branchCreated: true,
      values: {},
      dir: "/fd-home/workspaces/h1",
      files: [],
      nodes: [],
      manifest: "{}",
    };
    store.recordBuild(build);
    store.recordCost(runId, 0.25);

    expect(store.findRun(runId)).toEqual(inner.findRun(runId));
    expect(inner.findRun(runId)?.status).toBe("done");
    expect(inner.builds()).toEqual([build]);
    expect(inner.costOf(runId)).toBe(0.25);
    expect(store.listBuilds()).toEqual(inner.listBuilds());
    expect(store.findBuild("h1")).toEqual(inner.findBuild("h1"));
    expect(store.findBuildByName("b1")).toEqual(inner.findBuildByName("b1"));
    expect(store.buildFiles("h1")).toEqual(inner.buildFiles("h1"));
    expect(store.listRuns()).toEqual(inner.listRuns());
    expect(store.findRunSummary(runId)).toEqual(inner.findRunSummary(runId));
    expect(store.buildManifest("h1")).toBe("{}");
    expect(store.events(runId)).toEqual(inner.events(runId));
  });

  it("publishes one activity push for the node whose turn holds the stamp", () => {
    bash(350);

    expect(pushes).toEqual([
      {
        push: "activity",
        value: {
          runId,
          entry: {
            id: 1,
            nodeId: "p2",
            at: 350,
            kind: "tool",
            tool: "Bash",
            summary: "ls",
            input: '{"command":"ls"}',
          },
        },
      },
    ]);
  });

  it("shows a written file relative to the run's working folder", () => {
    hook("PreToolUse", 350, { tool_name: "Write", tool_input: { file_path: "/repo/src/a.ts" } });

    expect(activity().map((push) => push.value)).toMatchObject([
      { entry: { kind: "tool", path: "src/a.ts" } },
    ]);
  });

  it("places a stamp from an earlier turn on that turn's node even when it arrives late", () => {
    bash(150);

    expect(activity().map((push) => push.value)).toMatchObject([{ entry: { nodeId: "p1" } }]);
  });

  it("publishes nothing for another session's tool call", () => {
    bash(350, "s2");

    expect(pushes).toEqual([]);
  });

  it("publishes nothing for a stamp between two turns", () => {
    bash(250);

    expect(pushes).toEqual([]);
  });

  it("publishes a running subagent, then only that entry again when it finishes", () => {
    agent(350);
    agentDone(360);

    expect(pushes).toEqual([
      {
        push: "activity",
        value: {
          runId,
          entry: {
            id: 1,
            nodeId: "p2",
            at: 350,
            kind: "subagent",
            agentType: "general-purpose",
            summary: "Look",
            state: "running",
            toolUseId: "toolu_1",
          },
        },
      },
      {
        push: "activity",
        value: {
          runId,
          entry: {
            id: 1,
            nodeId: "p2",
            at: 350,
            kind: "subagent",
            agentType: "general-purpose",
            summary: "Look",
            state: "finished",
            toolUseId: "toolu_1",
            agentId: "agent-1",
          },
        },
      },
    ]);
  });

  it("logs a publish error instead of throwing it into the event source, and keeps going", () => {
    publish = () => {
      throw new Error("renderer gone");
    };

    expect(() => bash(350)).not.toThrow();
    expect(logs).toEqual([expect.stringContaining("renderer gone")]);

    publish = (push) => pushes.push(push);
    bash(360);

    expect(activity()).toHaveLength(1);
  });

  it("publishes nothing once unwatched", () => {
    agent(350);
    unwatch();

    bash(360);
    hook("SubagentStop", 370, { agent_id: "agent-1", agent_type: "general-purpose" });

    expect(activity()).toHaveLength(1);
  });

  it("stores each entry it publishes, and stores it again when it changes", () => {
    agent(350);
    agentDone(360);

    expect(inner.activity(runId)).toEqual([
      expect.objectContaining({ id: 1, kind: "subagent", state: "finished" }),
    ]);
  });

  it("writes a turn entry when a turn node is done, and a failure entry when a node fails", () => {
    clock = 400;
    store.append(runId, "p2", { kind: "done", payload: { stopMessage: "All set." } });
    store.appendAll(runId, [
      { nodeId: "p1", event: { kind: "reset" } },
      { nodeId: "p1", event: { kind: "running" } },
      {
        nodeId: "p1",
        event: { kind: "failed", payload: { message: "p1 failed: rejected: wrong scope" } },
      },
    ]);

    expect(activity().map((push) => push.value.entry)).toEqual([
      { id: 1, nodeId: "p2", at: 400, kind: "turn", summary: "All set." },
      { id: 2, nodeId: "p1", at: 400, kind: "failure", summary: "Rejected: wrong scope" },
    ]);
    expect(inner.activity(runId)).toHaveLength(2);
  });

  it("writes a pr entry for the URL gh pr create printed", () => {
    hook("PostToolUse", 350, {
      tool_name: "Bash",
      tool_input: { command: "gh pr create" },
      tool_response: { stdout: "https://github.com/acme/app/pull/7\n" },
    });

    expect(activity().map((push) => push.value.entry)).toMatchObject([
      { id: 1, nodeId: "p2", kind: "pr", url: "https://github.com/acme/app/pull/7" },
    ]);
  });

  it("stores and pushes a subagent's step on the node of the Agent call that runs it", () => {
    agent(350);
    hook("PreToolUse", 360, {
      agent_id: "agent-1",
      tool_name: "Read",
      tool_input: { file_path: "/repo/a.ts" },
      tool_use_id: "toolu_s1",
    });

    const step = { id: 2, nodeId: "p2", kind: "tool", tool: "Read", agentId: "agent-1" };
    expect(rows).toMatchObject([{ id: 1, kind: "subagent" }, step]);
    expect(activity().map((push) => push.value.entry)).toMatchObject([
      { id: 1, kind: "subagent" },
      step,
    ]);
  });

  it("stores and pushes one same-id row per step a finished Agent call moves to its node", () => {
    clock = 310;
    store.append(runId, "p1", { kind: "sent" });
    const call = (nodeId: string, at: number) =>
      hook("PreToolUse", at, {
        tool_name: "Agent",
        tool_input: { description: `Run ${nodeId}`, prompt: `NODE ${nodeId}\nGo` },
        tool_use_id: `toolu_${nodeId}`,
      });
    const step = (toolUseId: string, at: number) =>
      hook("PreToolUse", at, {
        agent_id: "agent-x",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: toolUseId,
      });
    call("p1", 350);
    call("p2", 351);
    step("toolu_x1", 360);
    step("toolu_x2", 370);
    const before = { rows: rows.length, pushes: activity().length };

    hook("PostToolUse", 380, {
      tool_name: "Agent",
      tool_input: { description: "Run p1", prompt: "NODE p1\nGo" },
      tool_use_id: "toolu_p1",
      tool_response: { status: "completed", agentId: "agent-x", agentType: "general-purpose" },
    });

    const moved = (entries: readonly ActivityEntry[]) =>
      entries.filter((entry) => entry.kind === "tool");
    expect(rows.slice(0, before.rows).filter((entry) => entry.kind === "tool")).toMatchObject([
      { id: 3, nodeId: "p2" },
      { id: 4, nodeId: "p2" },
    ]);
    expect(moved(rows.slice(before.rows))).toMatchObject([
      { id: 3, nodeId: "p1", agentId: "agent-x" },
      { id: 4, nodeId: "p1", agentId: "agent-x" },
    ]);
    expect(
      moved(
        activity()
          .slice(before.pushes)
          .map((push) => push.value.entry),
      ),
    ).toMatchObject([
      { id: 3, nodeId: "p1" },
      { id: 4, nodeId: "p1" },
    ]);
  });

  it("folds a failed tool call of the run's session onto its step", () => {
    hook("PreToolUse", 350, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/missing.txt" },
      tool_use_id: "toolu_r1",
    });
    hook("PostToolUseFailure", 355, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/missing.txt" },
      tool_use_id: "toolu_r1",
      error: "File does not exist.",
      duration_ms: 4,
    });

    expect(activity().map((push) => push.value.entry)).toMatchObject([
      { id: 1, kind: "tool", tool: "Read" },
      { id: 1, kind: "tool", result: "error", output: "File does not exist.", durationMs: 4 },
    ]);
    expect(inner.activity(runId)).toMatchObject([{ id: 1, result: "error" }]);
  });

  describe("the full text of a cut step", () => {
    const longOutput = "o".repeat(5_000);
    const longCommand = "c".repeat(3_000);
    const run = (command: string, output: string) => {
      hook("PreToolUse", 350, {
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "toolu_long",
      });
      hook("PostToolUse", 360, {
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "toolu_long",
        tool_response: output,
      });
    };

    it("stores a cut output's full text once", () => {
      run("ls", longOutput);

      expect(texts).toEqual([[runId, 1, "output", longOutput]]);
      expect(inner.stepTexts(runId, 1)).toEqual([{ field: "output", text: longOutput }]);
    });

    it("stores nothing for a step with nothing cut", () => {
      run("ls", "README.md\n");

      expect(texts).toEqual([]);
    });

    it("stores both fields when the input and the output were cut", () => {
      run(longCommand, longOutput);

      expect(texts).toEqual([
        [runId, 1, "input", JSON.stringify({ command: longCommand })],
        [runId, 1, "output", longOutput],
      ]);
    });

    it("pushes and records only the preview", () => {
      run("ls", longOutput);

      expect(activity().at(-1)?.value).toMatchObject({ entry: { output: previewOf(longOutput) } });
      expect(rows.at(-1)).toMatchObject({ output: previewOf(longOutput) });
    });
  });

  it("numbers new entries after the run's stored ones", () => {
    const stored = new FakeStore();
    const id = stored.createRun({
      buildDir: "/b",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run-test", cwd: "/repo", claudeSessionId: session },
      buildId: "b1",
    }).id;
    stored.recordActivity(id, { id: 7, nodeId: "p1", at: 1, kind: "turn", summary: "old" });
    const tracker = createActivityTracker({
      runId: id,
      now: () => 5,
      publish: (push) => pushes.push(push),
      log: () => undefined,
      activity: stored,
      turnNodes: new Set(),
      place: { cwd: "/repo" },
    });

    tracker.store(stored).append(id, "p1", {
      kind: "failed",
      payload: { message: "p1 failed: boom" },
    });

    expect(stored.activity(id).map((entry) => entry.id)).toEqual([7, 8]);
  });
});

describe("createBuildActivity", () => {
  it("records and pushes nothing for an Agent call that names no piece", () => {
    const store = new FakeStore();
    const pushes: EnginePush[] = [];
    const record = createBuildActivity({
      pendingId: "pending-1",
      now: () => 10,
      activity: store,
      publish: (push) => pushes.push(push),
    });

    record({ toolUseId: "toolu-1", agentType: "general-purpose" });
    record({ background: true, agentId: "a2acfd3c49ca63d33" });

    expect(store.buildActivity("pending-1")).toEqual([]);
    expect(pushes).toEqual([]);
  });

  describe("a build agent's own steps", () => {
    const pendingId = "pending-1";
    let store: FakeStore;
    let pushes: EnginePush[];
    let record: ReturnType<typeof createBuildActivity>;
    const step = (event: BuildStepEvent) => record.step(event);

    beforeEach(() => {
      store = new FakeStore();
      pushes = [];
      record = createBuildActivity({
        pendingId,
        now: () => 10,
        activity: store,
        publish: (push) => pushes.push(push),
      });
    });

    const latest = (): ActivityEntry[] => [
      ...new Map(store.buildActivity(pendingId).map((entry) => [entry.id, entry])).values(),
    ];
    const toolSteps = () =>
      latest().filter(
        (entry): entry is Extract<ActivityEntry, { kind: "tool" }> => entry.kind === "tool",
      );
    const start = (piece: string, toolUseId: string, agentType: string) =>
      record({ piece, toolUseId, agentType });
    const finish = (piece: string, toolUseId: string, agentType: string, agentId: string) =>
      record({ piece, toolUseId, agentType, agentId, status: "completed" });
    const inner = (agentId: string, agentType: string, toolUseId: string, at: number) => ({
      agent_id: agentId,
      agent_type: agentType,
      tool_name: "Read",
      tool_use_id: toolUseId,
      tool_input: { file_path: `/work/${toolUseId}.md` },
      flowdeck_hook_at: at,
    });
    const read = (agentId: string, agentType: string, toolUseId: string, at = 20) =>
      step({ kind: "PreToolUse", payload: inner(agentId, agentType, toolUseId, at) });
    const readDone = (agentId: string, agentType: string, toolUseId: string, at = 23) =>
      step({
        kind: "PostToolUse",
        payload: {
          ...inner(agentId, agentType, toolUseId, at),
          tool_response: "body",
          duration_ms: 3,
        },
      });

    it("credits a step to the one running piece of its agent type, with input, output and duration", () => {
      start("s1", "t1", "A1");
      start("s2", "t2", "A2");

      read("ag-1", "A1", "r1");
      readDone("ag-1", "A1", "r1");

      expect(toolSteps()).toEqual([
        expect.objectContaining({
          nodeId: "s1",
          tool: "Read",
          at: 20,
          input: previewOf(JSON.stringify({ file_path: "/work/r1.md" })),
          output: "body",
          result: "ok",
          durationMs: 3,
        }),
      ]);
    });

    it("ends a failed step as failed, with its error", () => {
      start("s1", "t1", "A1");

      read("ag-1", "A1", "b1");
      step({
        kind: "PostToolUseFailure",
        payload: { ...inner("ag-1", "A1", "b1", 25), error: "exit 1" },
      });

      expect(toolSteps()).toEqual([
        expect.objectContaining({ nodeId: "s1", result: "error", output: "exit 1" }),
      ]);
    });

    it("records no step whose agent type matches no started piece", () => {
      start("s1", "t1", "A1");

      read("ag-9", "A9", "r9");
      readDone("ag-9", "A9", "r9");

      expect(toolSteps()).toEqual([]);
    });

    it("holds the steps of pieces that share an agent type until each finish names its agent", () => {
      start("s1", "t1", "flowdeck-build:piece-auditor");
      start("s2", "t2", "flowdeck-build:piece-auditor");

      read("ag-1", "flowdeck-build:piece-auditor", "r1");
      readDone("ag-1", "flowdeck-build:piece-auditor", "r1");
      read("ag-2", "flowdeck-build:piece-auditor", "r2", 30);
      expect(toolSteps()).toEqual([]);

      finish("s2", "t2", "flowdeck-build:piece-auditor", "ag-2");
      expect(toolSteps().map((entry) => [entry.toolUseId, entry.nodeId])).toEqual([["r2", "s2"]]);

      finish("s1", "t1", "flowdeck-build:piece-auditor", "ag-1");
      expect(toolSteps().map((entry) => [entry.toolUseId, entry.nodeId, entry.result])).toEqual([
        ["r2", "s2", undefined],
        ["r1", "s1", "ok"],
      ]);
    });

    it("keeps one piece's steps off a later piece of the same agent type", () => {
      start("s1", "t1", "flowdeck-build:piece-auditor");
      read("ag-1", "flowdeck-build:piece-auditor", "r1");
      start("s2", "t2", "flowdeck-build:piece-auditor");
      read("ag-2", "flowdeck-build:piece-auditor", "r2");
      readDone("ag-1", "flowdeck-build:piece-auditor", "r1");
      read("ag-1", "flowdeck-build:piece-auditor", "r3");

      expect(toolSteps().map((entry) => [entry.toolUseId, entry.nodeId])).toEqual([
        ["r1", "s1"],
        ["r2", "s2"],
        ["r3", "s1"],
      ]);
    });

    it("puts the agent's report on its finish entry, as a preview", () => {
      const report = `Wrote s1. ${"r".repeat(3_000)}`;
      start("s1", "t1", "A1");

      record({ piece: "s1", toolUseId: "t1", agentType: "A1", status: "completed" }, report);

      expect(latest()).toEqual([
        expect.objectContaining({
          kind: "subagent",
          nodeId: "s1",
          state: "finished",
          report: previewOf(report),
        }),
      ]);
    });

    it("gives every entry a unique, rising id and sends each new or changed entry to the store and the page", () => {
      start("s1", "t1", "A1");
      read("ag-1", "A1", "r1");
      start("s2", "t2", "A2");
      readDone("ag-1", "A1", "r1");
      finish("s1", "t1", "A1", "ag-1");

      const appended = store.buildActivity(pendingId);
      const ids = [...new Set(appended.map((entry) => entry.id))];
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(latest().map((entry) => [entry.kind, entry.nodeId])).toEqual([
        ["subagent", "s1"],
        ["tool", "s1"],
        ["subagent", "s2"],
      ]);
      expect(pushes).toEqual(
        appended.map((entry) => ({ push: "build-activity", pendingId, entry })),
      );
    });

    it("keeps the piece as the summary of its start entry", () => {
      start("s1", "t1", "A1");
      read("ag-1", "A1", "r1");

      expect(latest().find((entry) => entry.kind === "subagent")?.summary).toBe("s1");
    });

    it("keeps the full input and output of a cut step", () => {
      const longPath = `/work/${"p".repeat(3_000)}.md`;
      const longOutput = `${"o".repeat(3_000)}END`;
      start("s1", "t1", "A1");
      step({
        kind: "PreToolUse",
        payload: { ...inner("ag-1", "A1", "r1", 20), tool_input: { file_path: longPath } },
      });
      step({
        kind: "PostToolUse",
        payload: {
          ...inner("ag-1", "A1", "r1", 23),
          tool_input: { file_path: longPath },
          tool_response: longOutput,
        },
      });

      const [cutStep] = toolSteps();
      expect(store.buildStepTexts(pendingId, cutStep?.id ?? -1)).toEqual([
        { field: "input", text: JSON.stringify({ file_path: longPath }) },
        { field: "output", text: longOutput },
      ]);
    });

    it("keeps the full report of an agent whose report was cut", () => {
      const report = `Wrote s1. ${"r".repeat(3_000)}`;
      start("s1", "t1", "A1");
      record({ piece: "s1", toolUseId: "t1", agentType: "A1", status: "completed" }, report);

      const [finished] = latest();
      expect(store.buildStepTexts(pendingId, finished?.id ?? -1)).toEqual([
        { field: "report", text: report },
      ]);
    });

    it("keeps no full text for a step and a report that were not cut", () => {
      start("s1", "t1", "A1");
      read("ag-1", "A1", "r1");
      readDone("ag-1", "A1", "r1");
      record({ piece: "s1", toolUseId: "t1", agentType: "A1", status: "completed" }, "short");

      for (const entry of latest()) {
        expect(store.buildStepTexts(pendingId, entry.id)).toEqual([]);
      }
    });
  });
});
