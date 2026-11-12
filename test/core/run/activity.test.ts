import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activityFeedSchema,
  activityUpdateSchema,
  emptyFeed,
  feedOf,
  foldHookEvent,
  foldNodeEvent,
  type ActivityEntry,
  type ActivityFeed,
  type ActivityHookEvent,
} from "../../../src/core/run/activity.js";
import { trackWindow, type NodeWindow } from "../../../src/core/run/attribution.js";

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
  inputs.reduce<{ feed: ActivityFeed; changes: (ActivityEntry | undefined)[] }>(
    ({ feed, changes }, input) => {
      const result = foldHookEvent(feed, windows, input);
      return { feed: result.feed, changes: [...changes, result.changed] };
    },
    { feed: start, changes: [] },
  );

const summaryOf = (toolInput: Record<string, unknown>) => {
  const { changed } = foldHookEvent(emptyFeed, windows, pre({ tool_input: toolInput }));
  return changed?.summary;
};

describe("foldHookEvent", () => {
  it("adds a tool entry for a main-session PreToolUse stamped inside a node's window", () => {
    const { feed, changed } = foldHookEvent(emptyFeed, windows, pre());

    expect(changed).toEqual({
      id: 1,
      nodeId: "p2",
      at: insideP2,
      kind: "tool",
      tool: "Bash",
      summary: "ls",
    });
    expect(feed.nextId).toBe(2);
    expect(feed.entries).toEqual([changed]);
  });

  it("adds nothing for a tool call made inside a subagent", () => {
    const result = foldHookEvent(emptyFeed, windows, pre({ agent_id: "agent-1" }));

    expect(result).toEqual({ feed: emptyFeed, changed: undefined });
  });

  it.each([
    ["outside every window", 250],
    ["with a stamp that is not a number", "350"],
    ["with no stamp", undefined],
  ])("adds nothing and keeps the next id for a PreToolUse %s", (_, stamp) => {
    const result = foldHookEvent(emptyFeed, windows, pre({ flowdeck_hook_at: stamp }));

    expect(result.changed).toBeUndefined();
    expect(result.feed.nextId).toBe(emptyFeed.nextId);
    expect(result.feed.entries).toEqual([]);
  });

  it("adds a running subagent entry for an Agent call, typed by its subagent_type", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      agentCall({ subagent_type: "h:a1", description: "Run a1", prompt: "Go" }),
    );

    expect(changed).toEqual({
      id: 1,
      nodeId: "p2",
      at: insideP2,
      kind: "subagent",
      agentType: "h:a1",
      summary: "Run a1",
      state: "running",
      toolUseId: "toolu_01FixturePreToolUse",
    });
  });

  it("types an Agent call with no subagent_type as general-purpose", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      agentCall({ description: "Look", prompt: "Go" }),
    );

    expect(changed).toMatchObject({ kind: "subagent", agentType: "general-purpose" });
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

    expect(changes[2]).toMatchObject({
      id: 2,
      state: "finished",
      summary: "Second",
      agentId: "agent-2",
    });
    expect(changes[3]).toMatchObject({
      id: 1,
      state: "finished",
      summary: "First",
      agentId: "agent-1",
    });
    expect(changes[4]).toBeUndefined();
    expect(feed.entries).toHaveLength(2);
    expect(feed.nextId).toBe(3);
  });

  it("finishes on a SubagentStop only the entry with its agent id, never the first of its type", () => {
    const { changes } = fold([
      agentCall({ description: "First", prompt: "Go" }),
      stopOf("general-purpose", "agent-elsewhere"),
    ]);

    expect(changes[1]).toBeUndefined();
  });

  it("counts five tool calls and one subagent as six entries", () => {
    const glob = (pattern: string) => pre({ tool_name: "Glob", tool_input: { pattern } });
    const { feed } = fold([
      glob("a*"),
      glob("b*"),
      glob("c*"),
      glob("d*"),
      glob("e*"),
      agentCall({ description: "Reply OK", prompt: "Reply OK" }),
      pre({ agent_id: "agent-1", tool_name: "Read", tool_input: { file_path: "/x" } }),
      pre({ agent_id: "agent-1", tool_name: "Grep", tool_input: { pattern: "y" } }),
      agentDone("toolu_01FixturePreToolUse", "agent-1"),
    ]);

    expect(feed.entries).toHaveLength(6);
    expect(feed.entries.filter((entry) => entry.kind === "tool")).toHaveLength(5);
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
    ).toMatchObject({ kind: "subagent", nodeId: "a2", agentType: "h:review" });
  });

  it("credits any other main-session tool to the fork", () => {
    expect(inSection({ tool_name: "TaskStop", tool_input: {} })).toMatchObject({
      kind: "tool",
      tool: "TaskStop",
      nodeId: "f",
    });
  });

  it("still drops a tool call made inside a subagent", () => {
    expect(inSection({ agent_id: "agent-1", tool_name: "Bash" })).toBeUndefined();
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
    inputs.reduce<{ feed: ActivityFeed; changes: (ActivityEntry | undefined)[] }>(
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

    expect(changes.map((change) => change?.nodeId)).toEqual(["a1", "a1", "a1", "a2", "a2", "a2"]);
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

      expect(changes[0]).toMatchObject({ nodeId: "b1", state: "running" });
      expect(changes[1]).toMatchObject({ nodeId: "b2", state: "running" });
      expect(changes[2]).toMatchObject({
        id: 2,
        nodeId: "b2",
        state: "finished",
        agentId: "agent-b2",
      });
      expect(feed.entries.find((entry) => entry.id === 1)).toMatchObject({ state: "running" });
    });

    it("moves an entry to the node its finished call's marker names", () => {
      const { changes } = foldOn(section, [
        call(undefined, "toolu_x", 1100),
        agentDone("toolu_x", "agent-x", "NODE b2\nGo", 1200),
      ]);

      expect(changes[0]).toMatchObject({ nodeId: "f" });
      expect(changes[1]).toMatchObject({ id: 1, nodeId: "b2", agentId: "agent-x" });
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

    expect(changes[1]).toBeUndefined();
  });

  it("ignores a tool event carrying an agent id while no Agent call is in flight", () => {
    expect(foldHookEvent(emptyFeed, windows, pre({ agent_id: "a2acfd3c49ca63d33" }))).toEqual({
      feed: emptyFeed,
      changed: undefined,
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

      expect(changed).toMatchObject({ kind: "tool", tool, path });
      expect(changed?.summary.length).toBeLessThanOrEqual(80);
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

    expect(changed).toMatchObject({ kind: "tool", path: shown });
  });

  it("keeps no path for a tool that only reads", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      pre({ tool_name: "Read", tool_input: { file_path: "/repo/a.ts" } }),
    );

    expect(changed).not.toHaveProperty("path");
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

    expect(changed).toEqual({
      id: 1,
      nodeId: "p2",
      at: insideP2,
      kind: "pr",
      url: "https://github.com/acme/app/pull/42",
      summary: "https://github.com/acme/app/pull/42",
    });
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
    ).toBeUndefined();
    expect(
      foldHookEvent(once.feed, windows, created("https://github.com/acme/app/pull/42")).changed,
    ).toBeUndefined();
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

    expect(changed).toBeUndefined();
  });

  it("adds nothing when the call has no output object", () => {
    const { changed } = foldHookEvent(
      emptyFeed,
      windows,
      post({ tool_input: ghPrCreate, tool_response: "https://github.com/acme/app/pull/42" }),
    );

    expect(changed).toBeUndefined();
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

    expect(changed).toMatchObject({ kind: "pr", url: "https://github.acme.corp/team/app/pull/7" });
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

    expect(changed).toEqual({
      id: 1,
      nodeId: "p1",
      at: 5,
      kind: "turn",
      summary: "Wrote the plan.",
    });
  });

  it("says the turn ended when it ended without a message", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "p1", at: 5, turnNodes },
      { kind: "done" },
    );

    expect(changed).toMatchObject({ kind: "turn", summary: "Turn ended" });
  });

  it("adds no turn entry for a node that takes no turn", () => {
    expect(
      foldNodeEvent(emptyFeed, { nodeId: "s1", at: 5, turnNodes }, { kind: "done" }).changed,
    ).toBeUndefined();
  });

  it("adds a failure entry in plain words for any failed node", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "s1", at: 9, turnNodes },
      { kind: "failed", payload: { message: "s1 failed: rejected: wrong scope" } },
    );

    expect(changed).toEqual({
      id: 1,
      nodeId: "s1",
      at: 9,
      kind: "failure",
      summary: "Rejected: wrong scope",
    });
  });
});

describe("context compaction in the feed", () => {
  it("adds a context entry with the size the context was compacted at", () => {
    const { changed } = foldNodeEvent(
      emptyFeed,
      { nodeId: "p2", at: 7, turnNodes: new Set(["p2"]) },
      { kind: "compacted", payload: { tokens: 162_400 } },
    );

    expect(changed).toEqual({
      id: 1,
      nodeId: "p2",
      at: 7,
      kind: "context",
      summary: "Context compacted at 162k tokens",
    });
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
