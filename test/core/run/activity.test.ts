import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activityFeedSchema,
  activityUpdateSchema,
  emptyFeed,
  feedOf,
  foldHookEvent,
  foldNodeEvent,
  isCut,
  previewOf,
  type ActivityEntry,
  type ActivityFeed,
  type ActivityHookEvent,
} from "../../../src/core/run/activity.js";
import { trackWindow, type NodeWindow } from "../../../src/core/run/attribution.js";
import { subagent as storedSubagent, tool as storedTool } from "../../fixtures/activity-entries.js";

type HookInput = ActivityHookEvent;

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/hooks/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

const preToolUse = fixture("pre-tool-use");
const subagentStop = fixture("subagent-stop");

const marks: [nodeId: string, kind: string, at: number][] = [
  ["p1", "sent", 100],
  ["p1", "done", 200],
  ["p2", "sent", 300],
  ["p2", "done", 400],
];
const windows = marks.reduce<NodeWindow[]>(
  (all, [nodeId, kind, at]) => trackWindow(all, nodeId, kind, at),
  [],
);

const insideP2 = 350;

const pre = (fields: Record<string, unknown> = {}): HookInput => ({
  kind: "PreToolUse",
  payload: { ...preToolUse, flowdeck_hook_at: insideP2, ...fields },
});

const agentCall = (toolInput: Record<string, unknown>): HookInput =>
  pre({ tool_name: "Agent", tool_input: toolInput });

const stopOf = (agentType: string, agentId = "agent-fixture-1"): HookInput => ({
  kind: "SubagentStop",
  payload: {
    ...subagentStop,
    flowdeck_hook_at: insideP2,
    agent_type: agentType,
    agent_id: agentId,
  },
});

const agentDone = (
  toolUseId: string,
  agentId: string,
  prompt = "Go",
  at: number = insideP2,
): HookInput => ({
  kind: "PostToolUse",
  payload: {
    flowdeck_hook_at: at,
    tool_name: "Agent",
    tool_input: { subagent_type: "h:review", prompt },
    tool_use_id: toolUseId,
    tool_response: { status: "completed", agentId, agentType: "h:review", content: [] },
  },
});

const fold = (inputs: readonly HookInput[], start: ActivityFeed = emptyFeed) =>
  inputs.reduce<{ feed: ActivityFeed; changes: (readonly ActivityEntry[])[] }>(
    ({ feed, changes }, input) => {
      const result = foldHookEvent(feed, windows, input);
      return { feed: result.feed, changes: [...changes, result.changed] };
    },
    { feed: start, changes: [] },
  );

const summaryOf = (toolInput: Record<string, unknown>) => {
  const { changed } = foldHookEvent(emptyFeed, windows, pre({ tool_input: toolInput }));
  return changed[0]?.summary;
};

describe("foldHookEvent", () => {
  it("adds a tool entry for a main-session PreToolUse stamped inside a node's window", () => {
    const { feed, changed } = foldHookEvent(emptyFeed, windows, pre());

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: insideP2,
        kind: "tool",
        tool: "Bash",
        summary: "ls",
        input: '{"command":"ls","description":"List files"}',
        toolUseId: "toolu_01FixturePreToolUse",
      },
    ]);
    expect(feed.nextId).toBe(2);
    expect(feed.entries).toEqual(changed);
  });

  it("adds a tool call made inside a subagent to the running Agent call's node, with its agent id", () => {
    const { changes } = fold([
      agentCall({ description: "Look", prompt: "Go" }),
      pre({ agent_id: "agent-1", tool_use_id: "toolu_sub" }),
    ]);

    expect(changes[1]).toEqual([
      {
        id: 2,
        nodeId: "p2",
        at: insideP2,
        kind: "tool",
        tool: "Bash",
        summary: "ls",
        input: '{"command":"ls","description":"List files"}',
        agentId: "agent-1",
        toolUseId: "toolu_sub",
      },
    ]);
  });

  it.each([
    ["outside every window", 250],
    ["with a stamp that is not a number", "350"],
    ["with no stamp", undefined],
  ])("adds nothing and keeps the next id for a PreToolUse %s", (_, stamp) => {
    const result = foldHookEvent(emptyFeed, windows, pre({ flowdeck_hook_at: stamp }));

    expect(result.changed).toEqual([]);
    expect(result.feed.nextId).toBe(emptyFeed.nextId);
    expect(result.feed.entries).toEqual([]);
  });

  it("adds a running subagent entry for an Agent call, typed by its subagent_type", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      agentCall({ subagent_type: "h:a1", description: "Run a1", prompt: "Go" }),
    );

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: insideP2,
        kind: "subagent",
        agentType: "h:a1",
        summary: "Run a1",
        state: "running",
        toolUseId: "toolu_01FixturePreToolUse",
      },
    ]);
  });

  it("types an Agent call with no subagent_type as general-purpose", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      agentCall({ description: "Look", prompt: "Go" }),
    );

    expect(changed).toMatchObject([{ kind: "subagent", agentType: "general-purpose" }]);
  });

  it("finishes each running subagent at its own finished Agent call, by call id", () => {
    const call = (description: string, toolUseId: string) =>
      pre({
        tool_name: "Agent",
        tool_input: { description, prompt: "Go" },
        tool_use_id: toolUseId,
      });
    const { changes, feed } = fold([
      call("First", "toolu_1"),
      call("Second", "toolu_2"),
      agentDone("toolu_2", "agent-2"),
      agentDone("toolu_1", "agent-1"),
      agentDone("toolu_1", "agent-1"),
    ]);

    expect(changes[2]).toMatchObject([
      {
        id: 2,
        state: "finished",
        summary: "Second",
        agentId: "agent-2",
      },
    ]);
    expect(changes[3]).toMatchObject([
      {
        id: 1,
        state: "finished",
        summary: "First",
        agentId: "agent-1",
      },
    ]);
    expect(changes[4]).toEqual([]);
    expect(feed.entries).toHaveLength(2);
    expect(feed.nextId).toBe(3);
  });

  it("finishes on a SubagentStop only the entry with its agent id, never the first of its type", () => {
    const { changes } = fold([
      agentCall({ description: "First", prompt: "Go" }),
      stopOf("general-purpose", "agent-elsewhere"),
    ]);

    expect(changes[1]).toEqual([]);
  });

  it("counts five main-session tool calls, the subagent's two and the subagent as eight entries", () => {
    const glob = (pattern: string) => pre({ tool_name: "Glob", tool_input: { pattern } });
    const { feed } = fold([
      glob("a*"),
      glob("b*"),
      glob("c*"),
      glob("d*"),
      glob("e*"),
      agentCall({ description: "Reply OK", prompt: "Reply OK" }),
      pre({
        agent_id: "agent-1",
        tool_name: "Read",
        tool_input: { file_path: "/x" },
        tool_use_id: "toolu_read",
      }),
      pre({
        agent_id: "agent-1",
        tool_name: "Grep",
        tool_input: { pattern: "y" },
        tool_use_id: "toolu_grep",
      }),
      agentDone("toolu_01FixturePreToolUse", "agent-1"),
    ]);

    expect(feed.entries).toHaveLength(8);
    expect(feed.entries.filter((entry) => entry.kind === "tool")).toHaveLength(7);
    expect(feed.entries.find((entry) => entry.kind === "subagent")).toMatchObject({
      state: "finished",
    });
  });
});

describe("foldHookEvent in a parallel section", () => {
  const sectionWindows = (["f", "a1", "a2"] as const).reduce<NodeWindow[]>(
    (all, nodeId) => trackWindow(all, nodeId, "sent", 1000),
    [],
  );
  const inSection = (fields: Record<string, unknown>) =>
    foldHookEvent(emptyFeed, sectionWindows, {
      kind: "PreToolUse",
      payload: { ...preToolUse, flowdeck_hook_at: 1500, ...fields },
    }).changed;

  it("credits an Agent call to the branch its node marker names", () => {
    expect(
      inSection({
        tool_name: "Agent",
        tool_input: { subagent_type: "h:review", description: "Run a2", prompt: "NODE a2\nGo" },
      }),
    ).toMatchObject([{ kind: "subagent", nodeId: "a2", agentType: "h:review" }]);
  });

  const laneCall = (nodeId: string): HookInput => ({
    kind: "PreToolUse",
    payload: {
      ...preToolUse,
      flowdeck_hook_at: 1400,
      tool_name: "Agent",
      tool_input: {
        subagent_type: "h:review",
        description: `Run ${nodeId}`,
        prompt: `NODE ${nodeId}\nGo`,
      },
      tool_use_id: `toolu_${nodeId}`,
    },
  });
  const inSectionWhile = (running: HookInput, fields: Record<string, unknown>) =>
    foldHookEvent(foldHookEvent(emptyFeed, sectionWindows, running).feed, sectionWindows, {
      kind: "PreToolUse",
      payload: { ...preToolUse, flowdeck_hook_at: 1500, tool_use_id: "toolu_step", ...fields },
    }).changed;

  it("credits a main-session tool to the fork and a subagent's tool to its lane", () => {
    expect(inSectionWhile(laneCall("a2"), { tool_name: "TaskStop", tool_input: {} })).toMatchObject(
      [{ kind: "tool", tool: "TaskStop", nodeId: "f" }],
    );
    expect(
      inSectionWhile(laneCall("a2"), { agent_id: "agent-1", tool_name: "Bash" }),
    ).toMatchObject([{ kind: "tool", tool: "Bash", nodeId: "a2", agentId: "agent-1" }]);
  });

  it("credits a tool call made inside a subagent to the one running Agent call's lane", () => {
    expect(
      inSectionWhile(laneCall("a1"), { agent_id: "agent-1", tool_name: "Bash" }),
    ).toMatchObject([{ kind: "tool", nodeId: "a1", agentId: "agent-1" }]);
  });
});

describe("Activity by node", () => {
  const call = (nodeId: string | undefined, toolUseId: string, at: number): HookInput => ({
    kind: "PreToolUse",
    payload: {
      ...preToolUse,
      flowdeck_hook_at: at,
      tool_name: "Agent",
      tool_input: {
        subagent_type: "h:review",
        description: `Review ${nodeId ?? "it"}`,
        prompt: nodeId === undefined ? "Go" : `NODE ${nodeId}\nGo`,
      },
      tool_use_id: toolUseId,
    },
  });
  const foldOn = (on: readonly NodeWindow[], inputs: readonly HookInput[]) =>
    inputs.reduce<{ feed: ActivityFeed; changes: (readonly ActivityEntry[])[] }>(
      ({ feed, changes }, input) => {
        const result = foldHookEvent(feed, on, input);
        return { feed: result.feed, changes: [...changes, result.changed] };
      },
      { feed: emptyFeed, changes: [] },
    );

  it("owns each in-flight call's activity by its node when two nodes in a row share a piece", () => {
    const sequence = (
      [
        ["a1", "sent", 100],
        ["a1", "done", 200],
        ["a2", "sent", 300],
        ["a2", "done", 400],
      ] as const
    ).reduce<NodeWindow[]>((all, [nodeId, kind, at]) => trackWindow(all, nodeId, kind, at), []);
    const bash = (at: number): HookInput => ({
      kind: "PreToolUse",
      payload: { ...preToolUse, flowdeck_hook_at: at },
    });

    const { changes } = foldOn(sequence, [
      call("a1", "toolu_1", 150),
      bash(160),
      agentDone("toolu_1", "agent-1", "NODE a1\nGo", 190),
      call("a2", "toolu_2", 350),
      bash(360),
      agentDone("toolu_2", "agent-2", "NODE a2\nGo", 390),
    ]);

    expect(changes).toMatchObject(
      ["a1", "a1", "a1", "a2", "a2", "a2"].map((nodeId) => [{ nodeId }]),
    );
  });

  describe("two parallel calls of one piece", () => {
    const section = (["f", "b1", "b2"] as const).reduce<NodeWindow[]>(
      (all, nodeId) => trackWindow(all, nodeId, "sent", 1000),
      [],
    );

    it("starts each call on its marker's node and finishes it by its own call id and agent id", () => {
      const { changes, feed } = foldOn(section, [
        call("b1", "toolu_b1", 1100),
        call("b2", "toolu_b2", 1101),
        agentDone("toolu_b2", "agent-b2", "NODE b2\nGo", 1200),
      ]);

      expect(changes[0]).toMatchObject([{ nodeId: "b1", state: "running" }]);
      expect(changes[1]).toMatchObject([{ nodeId: "b2", state: "running" }]);
      expect(changes[2]).toMatchObject([
        {
          id: 2,
          nodeId: "b2",
          state: "finished",
          agentId: "agent-b2",
        },
      ]);
      expect(feed.entries.find((entry) => entry.id === 1)).toMatchObject({ state: "running" });
    });

    it("moves an entry to the node its finished call's marker names", () => {
      const { changes } = foldOn(section, [
        call(undefined, "toolu_x", 1100),
        agentDone("toolu_x", "agent-x", "NODE b2\nGo", 1200),
      ]);

      expect(changes[0]).toMatchObject([{ nodeId: "f" }]);
      expect(changes[1]).toMatchObject([{ id: 1, nodeId: "b2", agentId: "agent-x" }]);
    });
  });

  it("ignores a SubagentStop with no agent type", () => {
    const { changes } = fold([
      agentCall({ description: "Look", prompt: "Go" }),
      {
        kind: "SubagentStop",
        payload: { flowdeck_hook_at: insideP2, agent_id: "a2acfd3c49ca63d33", agent_type: "" },
      },
    ]);

    expect(changes[1]).toEqual([]);
  });

  it("ignores a tool event carrying an agent id while no Agent call is in flight", () => {
    expect(foldHookEvent(emptyFeed, windows, pre({ agent_id: "a2acfd3c49ca63d33" }))).toEqual({
      feed: emptyFeed,
      changed: [],
      cut: [],
    });
  });
});

describe("a tool step's input, output, result and duration", () => {
  const postToolUse = fixture("post-tool-use");
  const without = (record: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
  const mainSessionFailure = without(fixture("post-tool-use-failure"), "agent_id", "agent_type");
  const bashOutput = { stdout: "README.md\n", stderr: "", interrupted: false };

  const foldSteps = (inputs: readonly HookInput[]) =>
    inputs.reduce<{ feed: ActivityFeed; changes: (readonly ActivityEntry[])[] }>(
      ({ feed, changes }, input) => {
        const result = foldHookEvent(feed, windows, input);
        return { feed: result.feed, changes: [...changes, result.changed] };
      },
      { feed: emptyFeed, changes: [] },
    );

  const post = (fields: Record<string, unknown> = {}): HookInput => ({
    kind: "PostToolUse",
    payload: {
      ...postToolUse,
      tool_name: "Bash",
      tool_input: { command: "ls", description: "List files" },
      tool_use_id: "toolu_01FixturePreToolUse",
      flowdeck_hook_at: insideP2 + 40,
      ...fields,
    },
  });

  const readMissing = pre({
    tool_name: "Read",
    tool_input: { file_path: "/tmp/fd-fixture/missing.txt" },
    tool_use_id: "toolu_01FixturePostToolUseFailure",
  });
  const readFailed: HookInput = {
    kind: "PostToolUseFailure",
    payload: { ...mainSessionFailure, flowdeck_hook_at: insideP2 + 5 },
  };

  it("keeps a long input as a preview", () => {
    const command = "x".repeat(2_500);
    const { changed } = foldHookEvent(emptyFeed, windows, pre({ tool_input: { command } }));

    expect(changed).toMatchObject([{ input: previewOf(JSON.stringify({ command })) }]);
    expect(changed[0]).not.toHaveProperty("result");
    expect(changed[0]).not.toHaveProperty("output");
    expect(changed[0]).not.toHaveProperty("durationMs");
  });

  it("adds a same-id row with the output, an ok result and the reported duration when the call ends", () => {
    const { changes, feed } = foldSteps([pre(), post()]);

    expect(changes[1]).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: insideP2,
        kind: "tool",
        tool: "Bash",
        summary: "ls",
        input: '{"command":"ls","description":"List files"}',
        output: JSON.stringify(bashOutput),
        result: "ok",
        durationMs: 42,
        toolUseId: "toolu_01FixturePreToolUse",
      },
    ]);
    expect(feed.entries).toEqual(changes[1]);
    expect(feed.nextId).toBe(2);
  });

  it("keeps a text output as it is, cut to a preview", () => {
    const text = "line\n".repeat(600);
    const { changes } = foldSteps([pre(), post({ tool_response: text })]);

    expect(changes[1]).toMatchObject([{ id: 1, output: previewOf(text), result: "ok" }]);
  });

  it("times a call with no reported duration from its start to its end stamp", () => {
    const unreported = without(post().payload, "duration_ms");
    const { changes } = foldSteps([pre(), { kind: "PostToolUse", payload: unreported }]);

    expect(changes[1]).toMatchObject([{ id: 1, result: "ok", durationMs: 40 }]);
  });

  it("adds a same-id row with an error result and the error text for a failed call", () => {
    const { feed } = foldSteps([readMissing]);

    expect(foldHookEvent(feed, windows, readFailed)).toMatchObject({
      changed: [
        {
          id: 1,
          kind: "tool",
          tool: "Read",
          result: "error",
          output: "File does not exist. Note: your current working directory is /tmp/fd-fixture.",
          durationMs: 4,
        },
      ],
    });
  });

  it("finishes the step and adds the pull request when gh pr create ends", () => {
    const url = "https://github.com/acme/app/pull/42";
    const command = "gh pr create --title x --body y";
    const { changes } = foldSteps([
      pre({ tool_input: { command } }),
      post({ tool_input: { command }, tool_response: { stdout: `${url}\n`, stderr: "" } }),
    ]);

    expect(changes[1]).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: insideP2,
        kind: "tool",
        tool: "Bash",
        summary: command,
        input: JSON.stringify({ command }),
        output: JSON.stringify({ stdout: `${url}\n`, stderr: "" }),
        result: "ok",
        durationMs: 42,
        toolUseId: "toolu_01FixturePreToolUse",
      },
      { id: 2, nodeId: "p2", at: insideP2 + 40, kind: "pr", url, summary: url },
    ]);
  });

  it("ends a step started before the feed was rebuilt from its stored entries", () => {
    const { feed } = foldSteps([pre()]);

    expect(foldHookEvent(feedOf(feed.entries), windows, post()).changed).toMatchObject([
      { id: 1, kind: "tool", tool: "Bash", result: "ok", durationMs: 42 },
    ]);
  });

  it("changes nothing for an end with no running step of that call id", () => {
    const { feed } = foldSteps([pre()]);

    expect(foldHookEvent(feed, windows, post({ tool_use_id: "toolu_other" }))).toEqual({
      feed,
      changed: [],
      cut: [],
    });
  });

  it("leaves a step that never ended without output, result or duration", () => {
    const { feed } = foldSteps([pre(), readMissing, post()]);
    const unended = feed.entries.find((entry) => entry.kind === "tool" && entry.tool === "Read");

    expect(unended).toBeDefined();
    expect(unended).not.toHaveProperty("output");
    expect(unended).not.toHaveProperty("result");
    expect(unended).not.toHaveProperty("durationMs");
  });

  describe("the full text of a cut field", () => {
    it("keeps a long output's preview and reports its full text", () => {
      const response = { stdout: "s".repeat(5_000) };
      const full = JSON.stringify(response);
      const { feed } = foldSteps([pre()]);

      const ended = foldHookEvent(feed, windows, post({ tool_response: response }));

      expect(ended.changed).toMatchObject([{ id: 1, output: previewOf(full) }]);
      expect(ended.changed[0]).toMatchObject({
        output: expect.stringMatching(/\n… cut, \d+ more characters$/) as unknown,
      });
      expect(ended.cut).toEqual([{ entryId: 1, field: "output", text: full }]);
    });

    it("reports a long input's full text", () => {
      const full = JSON.stringify({ command: "x".repeat(3_000) });

      const { cut } = foldHookEvent(
        emptyFeed,
        windows,
        pre({ tool_input: { command: "x".repeat(3_000) } }),
      );

      expect(cut).toEqual([{ entryId: 1, field: "input", text: full }]);
    });

    it("reports a failed call's long error as its output", () => {
      const error = "e".repeat(2_500);
      const { feed } = foldSteps([readMissing]);

      const { cut } = foldHookEvent(feed, windows, {
        kind: "PostToolUseFailure",
        payload: { ...readFailed.payload, error },
      });

      expect(cut).toEqual([{ entryId: 1, field: "output", text: error }]);
    });

    it("reports nothing when no field was cut", () => {
      const { feed } = foldSteps([pre()]);

      expect(foldHookEvent(emptyFeed, windows, pre()).cut).toEqual([]);
      expect(foldHookEvent(feed, windows, post()).cut).toEqual([]);
    });

    it("keeps text with lone surrogates as given", () => {
      const output = `${"a".repeat(1_999)}\uD800${"b".repeat(600)}\uDC00`;
      const { feed } = foldSteps([pre()]);

      const { cut } = foldHookEvent(feed, windows, post({ tool_response: output }));

      expect(cut).toEqual([{ entryId: 1, field: "output", text: output }]);
    });
  });
});

describe("a subagent's steps credited to its stage", () => {
  const lanes = (["l1", "l2"] as const).reduce<NodeWindow[]>(
    (all, nodeId) => trackWindow(all, nodeId, "sent", 1000),
    [],
  );
  const postToolUseAgent = fixture("post-tool-use-agent");

  const laneCall = (nodeId: string, agentType = "h:review"): HookInput => ({
    kind: "PreToolUse",
    payload: {
      ...preToolUse,
      flowdeck_hook_at: 1100,
      tool_name: "Agent",
      tool_input: {
        subagent_type: agentType,
        description: `Run ${nodeId}`,
        prompt: `NODE ${nodeId}\nGo`,
      },
      tool_use_id: `toolu_${nodeId}`,
    },
  });
  const laneDone = (nodeId: string, agentId: string, content: unknown[] = []): HookInput => ({
    kind: "PostToolUse",
    payload: {
      ...postToolUseAgent,
      flowdeck_hook_at: 1200,
      tool_input: {
        subagent_type: "h:review",
        description: `Run ${nodeId}`,
        prompt: `NODE ${nodeId}\nGo`,
      },
      tool_use_id: `toolu_${nodeId}`,
      tool_response: { status: "completed", agentId, agentType: "h:review", content },
    },
  });
  const stepOf = (agentId: string, toolUseId: string, at: number): HookInput => ({
    kind: "PreToolUse",
    payload: { ...preToolUse, flowdeck_hook_at: at, agent_id: agentId, tool_use_id: toolUseId },
  });
  const typedStep = (agentId: string, agentType: string, toolUseId: string, at: number) => {
    const step = stepOf(agentId, toolUseId, at);
    return { ...step, payload: { ...step.payload, agent_type: agentType } };
  };
  const laneStop = (agentId: string, agentType: string): HookInput => ({
    kind: "SubagentStop",
    payload: { ...subagentStop, flowdeck_hook_at: 1200, agent_id: agentId, agent_type: agentType },
  });
  const foldLanes = (inputs: readonly HookInput[]) =>
    inputs.reduce<{ feed: ActivityFeed; changes: (readonly ActivityEntry[])[] }>(
      ({ feed, changes }, input) => {
        const result = foldHookEvent(feed, lanes, input);
        return { feed: result.feed, changes: [...changes, result.changed] };
      },
      { feed: emptyFeed, changes: [] },
    );
  const entry = (feed: ActivityFeed, id: number) => feed.entries.find((known) => known.id === id);

  describe("link", () => {
    it("keeps the finished call's agent id and its report on the subagent entry", () => {
      const { changes } = foldLanes([
        laneCall("l1"),
        laneDone("l1", "agent-x", [
          { type: "text", text: "Found two files." },
          { type: "text", text: "Both read." },
        ]),
      ]);

      expect(changes[1]).toMatchObject([
        { id: 1, kind: "subagent", agentId: "agent-x", report: "Found two files.\nBoth read." },
      ]);
    });

    it("keeps a long report as a preview", () => {
      const text = "r".repeat(2_500);
      const { changes } = foldLanes([
        laneCall("l1"),
        laneDone("l1", "agent-x", [{ type: "text", text }]),
      ]);

      expect(changes[1]).toMatchObject([{ id: 1, report: previewOf(text) }]);
    });

    it("reports a long report's full text", () => {
      const text = "r".repeat(2_500);
      const { feed } = foldLanes([laneCall("l1")]);

      const { cut } = foldHookEvent(
        feed,
        lanes,
        laneDone("l1", "agent-x", [{ type: "text", text }]),
      );

      expect(cut).toEqual([{ entryId: 1, field: "report", text }]);
    });

    it("credits a later step of a linked agent to its call's node, not to the other running call", () => {
      const { changes } = foldLanes([
        laneCall("l1"),
        laneCall("l2"),
        laneDone("l2", "agent-x"),
        stepOf("agent-x", "toolu_x1", 1300),
      ]);

      expect(changes[3]).toMatchObject([{ id: 3, kind: "tool", nodeId: "l2", agentId: "agent-x" }]);
    });
  });

  describe("parallel lanes", () => {
    it("credits a step provisionally by time window, then moves it with a same-id row once its call links", () => {
      const { changes, feed } = foldLanes([
        laneCall("l1"),
        laneCall("l2"),
        stepOf("agent-x", "toolu_x1", 1150),
        stepOf("agent-y", "toolu_y1", 1160),
        laneDone("l2", "agent-x"),
        laneDone("l1", "agent-y"),
      ]);

      expect(changes[2]).toMatchObject([{ id: 3, kind: "tool", nodeId: "l1", agentId: "agent-x" }]);
      expect(changes[3]).toMatchObject([{ id: 4, kind: "tool", nodeId: "l1", agentId: "agent-y" }]);
      expect(changes[4]).toHaveLength(2);
      expect(changes[4]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 2, kind: "subagent", nodeId: "l2", agentId: "agent-x" }),
          { ...changes[2]?.[0], nodeId: "l2" },
        ]),
      );
      expect(changes[5]).toMatchObject([{ id: 1, kind: "subagent", agentId: "agent-y" }]);
      expect(entry(feed, 3)).toMatchObject({ nodeId: "l2" });
      expect(entry(feed, 4)).toMatchObject({ nodeId: "l1" });
      expect(feed.nextId).toBe(5);
    });

    it("credits each lane's step to the one running call of its agent type, the never-linked lane included", () => {
      const { feed } = foldLanes([
        laneCall("l1", "h:a1"),
        laneCall("l2", "h:a2"),
        typedStep("agent-x", "h:a1", "toolu_x1", 1150),
        typedStep("agent-y", "h:a2", "toolu_y1", 1160),
        typedStep("agent-x", "h:a1", "toolu_x2", 1170),
        typedStep("agent-y", "h:a2", "toolu_y2", 1180),
        laneDone("l1", "agent-x"),
      ]);

      expect(entry(feed, 3)).toMatchObject({ nodeId: "l1", agentId: "agent-x" });
      expect(entry(feed, 4)).toMatchObject({ nodeId: "l2", agentId: "agent-y" });
      expect(entry(feed, 5)).toMatchObject({ nodeId: "l1", agentId: "agent-x" });
      expect(entry(feed, 6)).toMatchObject({ nodeId: "l2", agentId: "agent-y" });
      expect(entry(feed, 2)).not.toHaveProperty("agentId");
    });

    it("credits by time window when two running calls share the step's agent type", () => {
      const { feed } = foldLanes([
        laneCall("l1", "h:a1"),
        laneCall("l2"),
        laneCall("l2"),
        typedStep("agent-y", "h:review", "toolu_y1", 1160),
      ]);

      expect(entry(feed, 4)).toMatchObject({ nodeId: "l1", agentId: "agent-y" });
    });

    it("credits by time window while a nested agent of another lane's type runs", () => {
      const nestedOfOtherType: HookInput = {
        kind: "PreToolUse",
        payload: {
          ...preToolUse,
          flowdeck_hook_at: 1150,
          agent_id: "agent-x",
          tool_name: "Agent",
          tool_input: { subagent_type: "h:a2", description: "Dig", prompt: "Go" },
          tool_use_id: "toolu_nested",
        },
      };
      const { feed } = foldLanes([
        laneCall("l1", "h:a1"),
        laneCall("l2", "h:a2"),
        { ...nestedOfOtherType, payload: { ...nestedOfOtherType.payload, agent_type: "h:a1" } },
        typedStep("agent-n", "h:a2", "toolu_n1", 1160),
      ]);

      expect(entry(feed, 3)).toMatchObject({ nodeId: "l1", tool: "Agent", agentId: "agent-x" });
      expect(entry(feed, 4)).toMatchObject({ nodeId: "l1", agentId: "agent-n" });
    });
  });

  describe('Join "first"', () => {
    it("links an agent with no finished call at SubagentStop by the one running call of its type, and moves its steps", () => {
      const { changes, feed } = foldLanes([
        laneCall("l1", "h:a1"),
        laneCall("l2", "h:a2"),
        stepOf("agent-x", "toolu_x1", 1150),
        laneStop("agent-x", "h:a2"),
      ]);

      expect(changes[2]).toMatchObject([{ id: 3, nodeId: "l1", agentId: "agent-x" }]);
      expect(changes[3]).toHaveLength(2);
      expect(changes[3]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 2, kind: "subagent", nodeId: "l2", agentId: "agent-x" }),
          expect.objectContaining({ id: 3, kind: "tool", nodeId: "l2", agentId: "agent-x" }),
        ]),
      );
      expect(entry(feed, 1)).not.toHaveProperty("agentId");
    });

    it("moves nothing when two running calls share the stopped agent's type", () => {
      const { changes, feed } = foldLanes([
        laneCall("l1"),
        laneCall("l2"),
        stepOf("agent-x", "toolu_x1", 1150),
        laneStop("agent-x", "h:review"),
      ]);

      expect(entry(feed, 3)).toMatchObject({ kind: "tool", nodeId: "l1", agentId: "agent-x" });
      expect(changes[3]).toEqual([]);
      expect(entry(feed, 1)).not.toHaveProperty("agentId");
      expect(entry(feed, 2)).not.toHaveProperty("agentId");
    });

    describe("after the cut-off lane's window closed", () => {
      const closed = (
        [
          ["l1", "sent", 1000],
          ["l2", "sent", 1000],
          ["l1", "done", 1250],
          ["l2", "skipped", 1250],
        ] as const
      ).reduce<NodeWindow[]>((all, [nodeId, kind, at]) => trackWindow(all, nodeId, kind, at), []);
      const afterJoin = (step: HookInput) =>
        [laneCall("l1", "h:a1"), laneCall("l2", "h:a2"), laneDone("l1", "agent-x"), step].reduce(
          (feed, input) => foldHookEvent(feed, closed, input).feed,
          emptyFeed,
        );

      it("drops a step from an unknown agent rather than crediting the cut-off lane", () => {
        const feed = afterJoin(stepOf("agent-bg", "toolu_bg", 1300));

        expect(feed.entries.filter((known) => known.kind === "tool")).toEqual([]);
      });

      it("still credits a late step of the cut-off lane's agent type to that lane", () => {
        const feed = afterJoin(typedStep("agent-y", "h:a2", "toolu_y9", 1300));

        expect(entry(feed, 3)).toMatchObject({ kind: "tool", nodeId: "l2", agentId: "agent-y" });
      });
    });
  });

  describe("nested agents", () => {
    const nestedCall: HookInput = {
      kind: "PreToolUse",
      payload: {
        ...preToolUse,
        flowdeck_hook_at: 1150,
        agent_id: "agent-x",
        tool_name: "Agent",
        tool_input: { subagent_type: "h:dig", description: "Dig", prompt: "Go" },
        tool_use_id: "toolu_nested",
      },
    };
    const nestedDone: HookInput = {
      kind: "PostToolUse",
      payload: {
        ...postToolUseAgent,
        flowdeck_hook_at: 1170,
        agent_id: "agent-x",
        tool_input: { subagent_type: "h:dig", description: "Dig", prompt: "Go" },
        tool_use_id: "toolu_nested",
        tool_response: { status: "completed", agentId: "agent-z", agentType: "h:dig", content: [] },
      },
    };
    const nested = [
      laneCall("l1"),
      laneCall("l2"),
      nestedCall,
      stepOf("agent-z", "toolu_z1", 1160),
      nestedDone,
    ];

    it("keeps an Agent step made inside a subagent as a step that names the nested agent", () => {
      const { changes } = foldLanes(nested);

      expect(changes[2]).toMatchObject([
        { id: 3, kind: "tool", tool: "Agent", agentId: "agent-x" },
      ]);
      expect(changes[4]).toMatchObject([
        { id: 3, kind: "tool", tool: "Agent", agentId: "agent-x", childAgentId: "agent-z" },
      ]);
    });

    it("names the nested agent on its step when the feed was rebuilt while it ran", () => {
      const { feed } = foldLanes(nested.slice(0, -1));

      expect(foldHookEvent(feedOf(feed.entries), lanes, nestedDone).changed).toMatchObject([
        { id: 3, kind: "tool", tool: "Agent", childAgentId: "agent-z" },
      ]);
    });

    it("moves the nested agent's steps along when the subagent that started it is re-credited", () => {
      const { changes } = foldLanes([...nested, laneDone("l2", "agent-x")]);

      expect(changes[5]).toHaveLength(3);
      expect(changes[5]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 2, kind: "subagent", nodeId: "l2" }),
          expect.objectContaining({ id: 3, kind: "tool", nodeId: "l2", childAgentId: "agent-z" }),
          expect.objectContaining({ id: 4, kind: "tool", nodeId: "l2", agentId: "agent-z" }),
        ]),
      );
    });

    it("credits a nested agent's step to the node of the step that started it", () => {
      const { changes } = foldLanes([
        ...nested,
        laneDone("l2", "agent-x"),
        stepOf("agent-z", "toolu_z2", 1210),
      ]);

      expect(changes[6]).toMatchObject([{ id: 5, kind: "tool", nodeId: "l2", agentId: "agent-z" }]);
    });

    it("keeps a nested agent stopped before its step ends off the call, and the call's agent's later steps on it", () => {
      const sameTypeNested: HookInput = {
        ...nestedCall,
        payload: {
          ...nestedCall.payload,
          tool_input: { subagent_type: "h:review", description: "Dig", prompt: "Go" },
        },
      };
      const { changes, feed } = foldLanes([
        laneCall("l1"),
        stepOf("agent-x", "toolu_x1", 1110),
        sameTypeNested,
        stepOf("agent-n", "toolu_n1", 1160),
        laneStop("agent-n", "h:review"),
        stepOf("agent-x", "toolu_x2", 1180),
      ]);

      expect(changes[4]).toEqual([]);
      expect(changes[5]).toMatchObject([{ id: 5, kind: "tool", nodeId: "l1", agentId: "agent-x" }]);
      expect(entry(feed, 1)).not.toHaveProperty("agentId");
    });
  });
});

describe("entry summary", () => {
  it("prefers file_path over command", () => {
    expect(summaryOf({ file_path: "/repo/a.ts", command: "cat a.ts" })).toBe("/repo/a.ts");
  });

  it("uses pattern when it is the only known field", () => {
    expect(summaryOf({ pattern: "src/**" })).toBe("src/**");
  });

  it("is empty when no known field is present", () => {
    expect(summaryOf({ url: "https://example.com" })).toBe("");
  });

  it("cuts a long value to 80 characters ending in an ellipsis", () => {
    const summary = summaryOf({ command: "x".repeat(200) });

    expect(summary).toHaveLength(80);
    expect(summary).toBe(`${"x".repeat(79)}…`);
  });

  it("keeps a value of exactly 80 characters whole", () => {
    expect(summaryOf({ command: "y".repeat(80) })).toBe("y".repeat(80));
  });
});

describe("activity schemas", () => {
  const tool: ActivityEntry = {
    id: 1,
    nodeId: "p2",
    at: 350,
    kind: "tool",
    tool: "Bash",
    summary: "ls",
  };
  const subagent: ActivityEntry = {
    id: 2,
    nodeId: "p2",
    at: 360,
    kind: "subagent",
    agentType: "general-purpose",
    summary: "Look",
    state: "running",
  };

  it("round-trips an update and a feed", () => {
    const update = { runId: "run-1", entry: subagent };
    const feed = { runId: "run-1", entries: [tool, subagent] };

    expect(activityUpdateSchema.parse(update)).toEqual(update);
    expect(activityFeedSchema.parse(feed)).toEqual(feed);
  });

  it("rejects an update whose entry has an unknown kind", () => {
    expect(
      activityUpdateSchema.safeParse({ runId: "run-1", entry: { ...tool, kind: "file" } }).success,
    ).toBe(false);
  });

  it("still parses entries stored before steps carried input and output", () => {
    const stored = [storedTool(1), storedSubagent(2, "running"), storedSubagent(3, "finished")];

    expect(activityFeedSchema.parse({ runId: "run-1", entries: stored }).entries).toEqual(stored);
  });

  it("keeps a tool step's input, output, result, duration, agents and call id", () => {
    const traced = {
      ...tool,
      input: '{"command":"ls"}',
      output: "a.txt",
      result: "error",
      durationMs: 42,
      agentId: "agent-1",
      childAgentId: "agent-2",
      toolUseId: "toolu_1",
    };

    expect(activityUpdateSchema.parse({ runId: "run-1", entry: traced }).entry).toEqual(traced);
  });

  it("keeps a subagent's id and report", () => {
    const reported = { ...subagent, agentId: "agent-1", report: "Found two files." };

    expect(activityUpdateSchema.parse({ runId: "run-1", entry: reported }).entry).toEqual(reported);
  });

  it("rejects a tool step whose result is neither ok nor error", () => {
    expect(
      activityUpdateSchema.safeParse({ runId: "run-1", entry: { ...tool, result: "partial" } })
        .success,
    ).toBe(false);
  });
});

describe("previewOf", () => {
  it("keeps text of up to 2,000 characters unchanged", () => {
    const text = "a".repeat(2_000);

    expect(previewOf(text)).toBe(text);
  });

  it("cuts longer text at 2,000 characters and says how much was cut", () => {
    const text = "a".repeat(2_000) + "b".repeat(537);

    expect(previewOf(text)).toBe(`${"a".repeat(2_000)}\n… cut, 537 more characters`);
  });
});

describe("isCut", () => {
  it("is true for a preview that was cut", () => {
    expect(isCut(previewOf("a".repeat(2_001)))).toBe(true);
  });

  it("is false for text that was not cut", () => {
    expect(isCut("a".repeat(2_000))).toBe(false);
  });

  it("is false for text that only mentions the marker before its end", () => {
    expect(isCut("\n… cut, 5 more characters and then more")).toBe(false);
  });
});

describe("the files a node wrote", () => {
  it.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])(
    "keeps the whole path of a %s call, however long",
    (tool) => {
      const path = `/repo/${"deep/".repeat(30)}file.ts`;
      const { changed } = foldHookEvent(
        emptyFeed,
        windows,
        pre({ tool_name: tool, tool_input: { file_path: path } }),
      );

      expect(changed).toMatchObject([{ kind: "tool", tool, path }]);
      expect(changed[0]?.summary.length).toBeLessThanOrEqual(80);
    },
  );

  it.each([
    ["/repo/src/a.ts", "src/a.ts"],
    ["/Users/me/.claude/notes.md", "outside the working folder: ~/.claude/notes.md"],
    ["/etc/hosts", "outside the working folder: /etc/hosts"],
    ["/repository/a.ts", "outside the working folder: /repository/a.ts"],
  ])("shows %s as %s, relative to the working folder", (path, shown) => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      pre({ tool_name: "Write", tool_input: { file_path: path } }),
      { cwd: "/repo", home: "/Users/me" },
    );

    expect(changed).toMatchObject([{ kind: "tool", path: shown }]);
  });

  it("keeps no path for a tool that only reads", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      pre({ tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } }),
    );

    expect(changed).toHaveLength(1);
    expect(changed[0]).not.toHaveProperty("path");
  });
});

describe("a pull request a node opened", () => {
  const post = (fields: Record<string, unknown>): ActivityHookEvent => ({
    kind: "PostToolUse",
    payload: { flowdeck_hook_at: insideP2, ...fields },
  });
  const created = (stdout: string) =>
    post({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --title x --body y" },
      tool_response: { stdout, stderr: "", interrupted: false },
    });

  it("adds a pr entry with the URL gh pr create printed, on the node in its turn", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      created("Creating pull request\nhttps://github.com/acme/app/pull/42\n"),
    );

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: insideP2,
        kind: "pr",
        url: "https://github.com/acme/app/pull/42",
        summary: "https://github.com/acme/app/pull/42",
      },
    ]);
  });

  it("adds nothing for a PR URL in another command's output, or a second time for the same URL", () => {
    const once = foldHookEvent(emptyFeed, windows, created("https://github.com/acme/app/pull/42"));

    expect(
      foldHookEvent(
        emptyFeed,
        windows,
        post({
          tool_name: "Bash",
          tool_input: { command: "cat notes.md" },
          tool_response: { stdout: "see https://github.com/acme/app/pull/42" },
        }),
      ).changed,
    ).toEqual([]);
    expect(
      foldHookEvent(once.feed, windows, created("https://github.com/acme/app/pull/42")).changed,
    ).toEqual([]);
  });
});

describe("a pull request gh pr create did not open", () => {
  const post = (fields: Record<string, unknown>): ActivityHookEvent => ({
    kind: "PostToolUse",
    payload: { flowdeck_hook_at: insideP2, tool_name: "Bash", ...fields },
  });
  const ghPrCreate = { command: "gh pr create --title x --body y" };

  it("adds nothing when the PR already exists and gh names it only in its error", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      post({
        tool_input: ghPrCreate,
        tool_response: {
          stdout: "",
          stderr:
            'a pull request for branch "fd" into branch "main" already exists:\nhttps://github.com/acme/app/pull/42\n',
          interrupted: false,
        },
      }),
    );

    expect(changed).toEqual([]);
  });

  it("adds nothing when the call has no output object", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      post({ tool_input: ghPrCreate, tool_response: "https://github.com/acme/app/pull/42" }),
    );

    expect(changed).toEqual([]);
  });

  it("adds a PR opened on a GitHub Enterprise host", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      post({
        tool_input: ghPrCreate,
        tool_response: { stdout: "https://github.acme.corp/team/app/pull/7\n", stderr: "" },
      }),
    );

    expect(changed).toMatchObject([
      { kind: "pr", url: "https://github.acme.corp/team/app/pull/7" },
    ]);
  });
});

describe("node events in the feed", () => {
  const turnNodes = new Set(["p1"]);

  it("adds a turn entry with the turn's last message when a turn node is done", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "p1", at: 5, turnNodes },
      { kind: "done", payload: { stopMessage: "Wrote the plan." } },
    );

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "p1",
        at: 5,
        kind: "turn",
        summary: "Wrote the plan.",
      },
    ]);
  });

  it("says the turn ended when it ended without a message", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "p1", at: 5, turnNodes },
      { kind: "done" },
    );

    expect(changed).toMatchObject([{ kind: "turn", summary: "Turn ended" }]);
  });

  it("adds no turn entry for a node that takes no turn", () => {
    expect(
      foldNodeEvent(emptyFeed, { nodeId: "s1", at: 5, turnNodes }, { kind: "done" }).changed,
    ).toEqual([]);
  });

  it("adds a failure entry in plain words for any failed node", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "s1", at: 9, turnNodes },
      { kind: "failed", payload: { message: "s1 failed: rejected: wrong scope" } },
    );

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "s1",
        at: 9,
        kind: "failure",
        summary: "Rejected: wrong scope",
      },
    ]);
  });
});

describe("context compaction in the feed", () => {
  it("adds a context entry with the size the context was compacted at", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "p2", at: 7, turnNodes: new Set(["p2"]) },
      { kind: "compacted", payload: { tokens: 162_400 } },
    );

    expect(changed).toEqual([
      {
        id: 1,
        nodeId: "p2",
        at: 7,
        kind: "context",
        summary: "Context compacted at 162k tokens",
      },
    ]);
  });
});

describe("feedOf", () => {
  it("continues numbering after the stored entries", () => {
    const stored: ActivityEntry[] = [
      { id: 4, nodeId: "p1", at: 1, kind: "turn", summary: "a" },
      { id: 2, nodeId: "p1", at: 1, kind: "turn", summary: "b" },
    ];

    expect(feedOf(stored).nextId).toBe(5);
    expect(feedOf([]).nextId).toBe(1);
  });
});
