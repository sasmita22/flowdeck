import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartedSessions } from "../../../src/app/engine/started-sessions.js";
import type { ManifestContainer, ManifestNode } from "../../../src/core/compiler/lower.js";
import type { LoadedBuild, StartedSessionsView } from "../../../src/core/run/execute.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { NodeState } from "../../../src/core/run/state.js";
import type { EventEntry, RunSession, StoredEvent } from "../../../src/core/run/store.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import type { WaitReply } from "../../../src/ports/waiter.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakePermissionSource } from "../../fakes/fake-permission-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";

const workspaceId = "00000000-0000-4000-8000-000000000000";
const androidId = "11111111-1111-4111-8111-111111111111";
const iosId = "22222222-2222-4222-8222-222222222222";
const androidTmux = "fd-run-aaaaaaaa";
const iosTmux = "fd-run-bbbbbbbb";
const longEnough = 60_000;

const node = (id: string, type: ManifestNode["type"], label: string): ManifestNode =>
  ({ id, type, label, settings: {} }) as ManifestNode;

const thenWire = (from: string, to: string) => ({
  kind: "then" as const,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const container = (
  kind: ManifestContainer["kind"],
  slug: string,
  worktree?: string,
  agents: string[] = ["a1"],
): ManifestContainer => {
  const ids = [`${slug}-start`, ...agents.map((agent) => `${slug}-${agent}`), `${slug}-stop`];
  return {
    kind,
    name: slug,
    slug,
    prefix: `fix-login-${slug}`,
    ...(worktree === undefined ? {} : { worktree }),
    model: "haiku",
    nodes: [
      node(`${slug}-start`, "trigger", "Start"),
      ...agents.map((agent) => node(`${slug}-${agent}`, "agent", agent)),
      node(`${slug}-stop`, "output", "Stop"),
    ],
    wires: ids.slice(1).map((id, index) => thenWire(ids[index] as string, id)),
    orchestrator: `${slug}/orchestrator.md`,
  };
};

const buildWith = (hash: string, iosAgents: string[]) =>
  ({
    version: 1,
    hash,
    layout: "workspace",
    cwd: "/b/workspace",
    containers: [
      container("workspace", "workspace"),
      container("session", "android", "/b/sessions/android/app"),
      container("session", "ios", "/b/sessions/ios/app", iosAgents),
    ],
    files: {},
  }) as unknown as LoadedBuild;

const manifest = buildWith("h1", ["a1", "a2"]);

const sessions: RunSession[] = [
  { tmuxName: androidTmux, cwd: "/b/sessions/android/app", claudeSessionId: androidId },
  { tmuxName: iosTmux, cwd: "/b/sessions/ios/app", claudeSessionId: iosId },
];

const hookEvent = (
  kind: HookEventKind,
  sessionId: string,
  payload: Record<string, unknown> = {},
): HookEvent => ({
  kind,
  sessionId,
  payload: { hook_event_name: kind, session_id: sessionId, flowdeck_hook_at: 1000, ...payload },
});

const agentInput = (slug: string, agent: string) => ({
  subagent_type: `fix-login-${slug}:${slug}-${agent}`,
  description: "Run",
  prompt: `NODE ${slug}-${agent}\nGo`,
});

const bash = (sessionId: string) =>
  hookEvent("PreToolUse", sessionId, { tool_name: "Bash", tool_input: { command: "ls" } });

const agentCall = (
  slug: string,
  sessionId: string,
  agent = "a1",
  kind: HookEventKind = "PreToolUse",
) =>
  hookEvent(kind, sessionId, {
    tool_name: "Agent",
    tool_input: agentInput(slug, agent),
    tool_use_id: `toolu-${slug}-${agent}`,
  });

const agentDone = (slug: string, sessionId: string, agent = "a1") =>
  agentCall(slug, sessionId, agent, "PostToolUse");

const stop = (sessionId: string) =>
  hookEvent("Stop", sessionId, { last_assistant_message: "all done" });

describe("StartedSessions", () => {
  let store: FakeStore;
  let runId: string;
  let events: FakeEventSource;
  let permissions: FakePermissionSource;
  let waiter: FakeWaiter;
  let alive: Record<string, boolean>;
  let aliveChecks: string[];
  let ended: string[];
  let answered: string[];
  let writes: string[];

  const supervisor = ({
    dialogs = false,
    replies = [],
    history,
    fs,
    build = manifest,
  }: {
    dialogs?: boolean | "fail" | Promise<void>;
    replies?: (WaitReply | Promise<WaitReply>)[];
    history?: StoredEvent[];
    fs?: FakeFileSystem;
    build?: LoadedBuild;
  } = {}) => {
    waiter = new FakeWaiter(replies);
    if (build !== manifest) runId = runOf(build);
    return new StartedSessions({
      runId,
      events,
      permissions,
      store,
      waiter,
      sessionAlive: async (name) => {
        aliveChecks.push(name);
        return alive[name] ?? false;
      },
      endSession: async (name) => {
        ended.push(name);
        alive[name] = false;
      },
      ...(dialogs === false
        ? {}
        : {
            answerDialogs: async (name: string) => {
              answered.push(name);
              if (dialogs === "fail") throw new Error("the trust dialog never appeared");
              if (dialogs !== true) await dialogs;
            },
          }),
      writeStates: (text) => writes.push(text),
      manifest: build,
      sessions,
      ...(history === undefined ? {} : { history }),
      ...(fs === undefined ? {} : { fs }),
    });
  };

  const runOf = (build: LoadedBuild) =>
    store.createRun({
      buildDir: "/b",
      inputs: {},
      nodeIds: (build.containers ?? []).flatMap((each) => each.nodes.map(({ id }) => id)),
      session: { tmuxName: "fd-run-00000000", cwd: "/b/workspace", claudeSessionId: workspaceId },
      sessions,
      buildId: build.hash,
    }).id;

  const statusOf = (nodeId: string): NodeState =>
    nodeStatus(store.events(runId).filter((event) => event.nodeId === nodeId));

  const nodeEventsFor = (slug: string) =>
    store.events(runId).filter((event) => event.nodeId.startsWith(`${slug}-`));

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    runId = runOf(manifest);
    events = new FakeEventSource();
    permissions = new FakePermissionSource();
    alive = {};
    aliveChecks = [];
    ended = [];
    answered = [];
    writes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is the core's view of the started sessions", () => {
    const view: StartedSessionsView = supervisor();

    expect(view.started()).toEqual([]);
    expect(view.failure()).toBeUndefined();
  });

  describe("permission requests", () => {
    it.each([
      ["android", androidId],
      ["ios", iosId],
    ])("answers a request from %s's session through the waiter", async (_name, sessionId) => {
      supervisor({ replies: [{ decision: "approve" }] });
      events.publish(bash(sessionId));

      const decision = await permissions.ask(sessionId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });

      expect(decision).toEqual({ behavior: "allow" });
      expect(waiter.calls).toEqual([
        expect.objectContaining({ kind: "permission", tool: "Bash", input: "git push" }),
      ]);
    });

    it("passes the waiter's rejection back to the session", async () => {
      supervisor({ replies: [{ decision: "reject", reason: "not now" }] });
      events.publish(bash(androidId));

      const decision = await permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });

      expect(decision).toEqual({ behavior: "deny", message: "not now" });
    });

    it("holds the session's running node at needs-you while the user decides, then sets it running again", async () => {
      let decide: (reply: WaitReply) => void = () => undefined;
      supervisor({ replies: [new Promise<WaitReply>((resolve) => (decide = resolve))] });
      events.publish(agentCall("android", androidId));
      expect(statusOf("android-a1")).toBe("running");

      const decision = permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(waiter.calls).toEqual([
        expect.objectContaining({ kind: "permission", nodeId: "android-a1", tool: "Bash" }),
      ]);
      expect(statusOf("android-a1")).toBe("needs-you");
      expect(statusOf("android-start")).toBe("done");

      decide({ decision: "approve" });

      expect(await decision).toEqual({ behavior: "allow" });
      expect(statusOf("android-a1")).toBe("running");
      expect(nodeEventsFor("ios")).toEqual([]);
    });

    it("holds a sibling still running at needs-you once the first of two parallel nodes is done", async () => {
      let decide: (reply: WaitReply) => void = () => undefined;
      supervisor({ replies: [new Promise<WaitReply>((resolve) => (decide = resolve))] });
      events.publish(agentCall("ios", iosId, "a1"));
      events.publish(agentCall("ios", iosId, "a2"));
      expect(() => events.publish(agentDone("ios", iosId, "a1"))).not.toThrow();

      const decision = permissions.ask(iosId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(waiter.calls).toEqual([
        expect.objectContaining({ kind: "permission", nodeId: "ios-a2", tool: "Bash" }),
      ]);
      expect(statusOf("ios-a1")).toBe("done");
      expect(statusOf("ios-a2")).toBe("needs-you");

      decide({ decision: "approve" });

      expect(await decision).toEqual({ behavior: "allow" });
      expect(statusOf("ios-a2")).toBe("running");
    });

    it("adds no second needs-you when a node restored waiting for you gets a new ask", async () => {
      const restored: EventEntry[] = [
        { nodeId: "android-start", event: { kind: "running" } },
        { nodeId: "android-start", event: { kind: "done" } },
        { nodeId: "android-a1", event: { kind: "running" } },
        { nodeId: "android-a1", event: { kind: "needs-you" } },
      ];
      store.appendAll(runId, restored);
      let decide: (reply: WaitReply) => void = () => undefined;
      supervisor({
        replies: [new Promise<WaitReply>((resolve) => (decide = resolve))],
        history: store.events(runId),
      });

      const decision = permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(statusOf("android-a1")).toBe("needs-you");

      decide({ decision: "approve" });

      expect(await decision).toEqual({ behavior: "allow" });
      expect(statusOf("android-a1")).toBe("running");
    });

    describe("from one of two parallel Agents", () => {
      const subagentId = "a2acfd3c49ca63d33";
      const transcripts = "/home/.claude/projects/-b-sessions-ios-app";
      const metaPath = `${transcripts}/${iosId}/subagents/agent-${subagentId}.meta.json`;
      const shared = "fix-login-ios:shared";
      const sharedCall = (agent: string) =>
        hookEvent("PreToolUse", iosId, {
          tool_name: "Agent",
          tool_input: { ...agentInput("ios", agent), subagent_type: shared },
          tool_use_id: `toolu-ios-${agent}`,
        });
      const subagentAsk = (agentType: string) => ({
        tool_name: "Bash",
        tool_input: { command: "git push" },
        session_id: iosId,
        transcript_path: `${transcripts}/${iosId}.jsonl`,
        agent_id: subagentId,
        agent_type: agentType,
      });
      const pendingAsk = async (payload: Record<string, unknown>) => {
        void permissions.ask(iosId, payload);
        await vi.advanceTimersByTimeAsync(0);
      };

      it("holds the Agent of the asking subagent's type at needs-you and leaves its sibling running", async () => {
        supervisor({ replies: [new Promise<WaitReply>(() => undefined)] });
        events.publish(agentCall("ios", iosId, "a1"));
        events.publish(agentCall("ios", iosId, "a2"));

        await pendingAsk(subagentAsk("fix-login-ios:ios-a2"));

        expect(waiter.calls).toEqual([
          expect.objectContaining({ kind: "permission", nodeId: "ios-a2", tool: "Bash" }),
        ]);
        expect(statusOf("ios-a2")).toBe("needs-you");
        expect(statusOf("ios-a1")).toBe("running");
      });

      it("finds the asking Agent of a shared type from its subagent's meta file, once", async () => {
        const fs = new FakeFileSystem({
          [metaPath]: JSON.stringify({ agentType: shared, toolUseId: "toolu-ios-a2" }),
        });
        supervisor({ replies: [{ decision: "approve" }, { decision: "approve" }], fs });
        events.publish(sharedCall("a1"));
        events.publish(sharedCall("a2"));

        await pendingAsk(subagentAsk(shared));
        await pendingAsk(subagentAsk(shared));

        expect(waiter.calls).toEqual([
          expect.objectContaining({ kind: "permission", nodeId: "ios-a2" }),
          expect.objectContaining({ kind: "permission", nodeId: "ios-a2" }),
        ]);
        expect(waiter.calls[0]).not.toHaveProperty("candidates");
        expect(fs.calls.filter(({ path }) => path === metaPath)).toHaveLength(1);
        expect(nodeEventsFor("ios").filter(({ nodeId }) => nodeId === "ios-a1")).toEqual([
          expect.objectContaining({ kind: "running" }),
        ]);
      });

      it("holds the first open Agent at needs-you for an ask from the main thread", async () => {
        supervisor({ replies: [new Promise<WaitReply>(() => undefined)] });
        events.publish(agentCall("ios", iosId, "a1"));
        events.publish(agentCall("ios", iosId, "a2"));

        await pendingAsk({ tool_name: "Bash", tool_input: { command: "git push" } });

        expect(waiter.calls).toEqual([
          expect.objectContaining({ kind: "permission", nodeId: "ios-a1" }),
        ]);
        expect(waiter.calls[0]).not.toHaveProperty("candidates");
        expect(statusOf("ios-a1")).toBe("needs-you");
        expect(statusOf("ios-a2")).toBe("running");
      });

      it("records no needs-you for an ask whose Agents failed while its meta file was read", async () => {
        const fs = new FakeFileSystem();
        let release: (content: string) => void = () => undefined;
        vi.spyOn(fs, "readFile").mockReturnValue(
          new Promise<string>((resolve) => {
            release = resolve;
          }),
        );
        supervisor({ replies: [{ decision: "approve" }], fs });
        alive[iosTmux] = true;
        events.publish(sharedCall("a1"));
        events.publish(sharedCall("a2"));
        const decision = permissions.ask(iosId, subagentAsk(shared));
        await vi.advanceTimersByTimeAsync(0);

        alive[iosTmux] = false;
        await vi.advanceTimersByTimeAsync(longEnough);
        release(JSON.stringify({ toolUseId: "toolu-ios-a2" }));
        await vi.advanceTimersByTimeAsync(0);

        await expect(decision).resolves.toBeDefined();
        expect(statusOf("ios-a1")).toBe("failed");
        expect(statusOf("ios-a2")).toBe("failed");
        expect(nodeEventsFor("ios").filter(({ kind }) => kind === "needs-you")).toEqual([]);
      });

      it("records no needs-you for an ask withdrawn while its meta file was read", async () => {
        const fs = new FakeFileSystem();
        let release: (content: string) => void = () => undefined;
        vi.spyOn(fs, "readFile").mockReturnValue(
          new Promise<string>((resolve) => {
            release = resolve;
          }),
        );
        supervisor({ replies: [{ decision: "approve" }], fs });
        events.publish(sharedCall("a1"));
        events.publish(sharedCall("a2"));
        const withdrawn = new AbortController();
        const decision = permissions.ask(iosId, subagentAsk(shared), withdrawn.signal);
        await vi.advanceTimersByTimeAsync(0);

        withdrawn.abort();
        release(JSON.stringify({ toolUseId: "toolu-ios-a2" }));
        await vi.advanceTimersByTimeAsync(0);

        await expect(decision).resolves.toBeDefined();
        expect(nodeEventsFor("ios").filter(({ kind }) => kind === "needs-you")).toEqual([]);
      });

      it("looks again for a subagent whose cached Agent has finished while two siblings run", async () => {
        const fs = new FakeFileSystem({
          [metaPath]: JSON.stringify({ agentType: shared, toolUseId: "toolu-ios-a2" }),
        });
        supervisor({
          replies: [{ decision: "approve" }, new Promise<WaitReply>(() => undefined)],
          fs,
          build: buildWith("h3", ["a1", "a2", "a3"]),
        });
        events.publish(sharedCall("a1"));
        events.publish(sharedCall("a2"));
        events.publish(sharedCall("a3"));
        await pendingAsk(subagentAsk(shared));

        events.publish(
          hookEvent("PostToolUse", iosId, {
            tool_name: "Agent",
            tool_input: { ...agentInput("ios", "a2"), subagent_type: shared },
            tool_use_id: "toolu-ios-a2",
          }),
        );
        await pendingAsk(subagentAsk(shared));

        expect(waiter.calls[1]).toEqual(
          expect.objectContaining({
            kind: "permission",
            nodeId: "ios-a1",
            candidates: ["ios-a1", "ios-a3"],
          }),
        );
        expect(fs.calls.filter(({ path }) => path === metaPath)).toHaveLength(2);
        expect(statusOf("ios-a2")).toBe("done");
        expect(statusOf("ios-a1")).toBe("needs-you");
      });

      it.each([
        { name: "no file reader", files: undefined },
        { name: "no meta file", files: {} },
        { name: "a meta file that is not JSON", files: { [metaPath]: "{not json" } },
        { name: "a meta file without a toolUseId", files: { [metaPath]: "[]" } },
        {
          name: "a meta file naming no open Agent",
          files: { [metaPath]: JSON.stringify({ toolUseId: "toolu-elsewhere" }) },
        },
      ])(
        "holds the first open Agent at needs-you and names every candidate with $name",
        async ({ files }) => {
          supervisor({
            replies: [new Promise<WaitReply>(() => undefined)],
            ...(files === undefined ? {} : { fs: new FakeFileSystem(files) }),
          });
          events.publish(sharedCall("a1"));
          events.publish(sharedCall("a2"));

          await pendingAsk(subagentAsk(shared));

          expect(waiter.calls).toEqual([
            expect.objectContaining({
              kind: "permission",
              nodeId: "ios-a1",
              candidates: ["ios-a1", "ios-a2"],
            }),
          ]);
          expect(statusOf("ios-a1")).toBe("needs-you");
          expect(statusOf("ios-a2")).toBe("running");
        },
      );
    });

    it("writes nothing when a permission wait settles after halt", async () => {
      let decide: (reply: WaitReply) => void = () => undefined;
      const sessionsView = supervisor({
        replies: [new Promise<WaitReply>((resolve) => (decide = resolve))],
      });
      events.publish(agentCall("android", androidId));
      const decision = permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(statusOf("android-a1")).toBe("needs-you");
      const before = store.events(runId).length;

      sessionsView.halt();
      decide({ decision: "approve" });
      await decision;

      expect(store.events(runId)).toHaveLength(before);
      expect(statusOf("android-a1")).toBe("needs-you");
    });

    it("stops answering once finished", async () => {
      const sessionsView = supervisor({ replies: [{ decision: "approve" }] });
      events.publish(bash(androidId));
      await sessionsView.finish();

      const decision = await permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });

      expect(decision.behavior).toBe("deny");
      expect(waiter.calls).toEqual([]);
    });
  });

  describe("hook events", () => {
    it("appends android's node events through the store, under android's nodes only", () => {
      supervisor();

      events.publish(bash(androidId));
      events.publish(agentCall("android", androidId));

      expect(statusOf("android-start")).toBe("done");
      expect(statusOf("android-a1")).toBe("running");
      expect(nodeEventsFor("ios")).toEqual([]);
      expect(nodeEventsFor("workspace")).toEqual([]);
    });

    it("feeds each session's events to its own container", () => {
      supervisor();

      events.publish(bash(androidId));
      events.publish(agentCall("ios", iosId));
      events.publish(agentDone("android", androidId));
      events.publish(stop(androidId));

      expect(statusOf("android-stop")).toBe("done");
      expect(statusOf("ios-a1")).toBe("running");
      expect(statusOf("ios-stop")).toBe("waiting");
    });

    it("ignores the workspace session's events", () => {
      supervisor();

      events.publish(bash(workspaceId));
      events.publish(stop(workspaceId));

      expect(store.events(runId)).toEqual([]);
    });
  });

  describe("started()", () => {
    it("lists only the sessions that delivered an event", () => {
      const sessionsView = supervisor();
      expect(sessionsView.started()).toEqual([]);

      events.publish(bash(iosId));

      expect(sessionsView.started()).toEqual([iosId]);
    });
  });

  describe("a started session whose tmux session dies", () => {
    it("fails its open node when the session is gone before its Stop", async () => {
      const sessionsView = supervisor();
      alive[androidTmux] = true;
      events.publish(bash(androidId));
      events.publish(agentCall("android", androidId));
      await vi.advanceTimersByTimeAsync(longEnough);
      expect(statusOf("android-a1")).toBe("running");
      expect(sessionsView.failure()).toBeUndefined();

      alive[androidTmux] = false;
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(statusOf("android-a1")).toBe("failed");
      expect(sessionsView.failure()).toMatchObject({ container: "android" });
    });

    it("writes nothing and records no failure for a node it is told to fail after halt", async () => {
      const sessionsView = supervisor();
      events.publish(bash(androidId));
      const before = store.events(runId).length;

      sessionsView.halt();
      sessionsView.failNode(androidId, "android-a1", "The run was stopped");

      expect(store.events(runId)).toHaveLength(before);
      expect(sessionsView.failure()).toBeUndefined();
    });

    it("adds nothing after a node it was told to fail, for a death or a later hook", async () => {
      const sessionsView = supervisor();
      alive[androidTmux] = true;
      events.publish(bash(androidId));
      await vi.advanceTimersByTimeAsync(longEnough);

      sessionsView.failNode(androidId, "android-a1", "tmux: no server running");
      const before = store.events(runId).length;
      alive[androidTmux] = false;
      await vi.advanceTimersByTimeAsync(longEnough);
      events.publish(agentCall("android", androidId));
      events.publish(stop(androidId));

      expect(statusOf("android-a1")).toBe("failed");
      expect(store.events(runId)).toHaveLength(before);
      expect(sessionsView.failure()).toMatchObject({ container: "android" });
    });

    it.each([false, true])(
      "never reads a never-started session's missing tmux session as a death (dialogs %s)",
      async (dialogs) => {
        const sessionsView = supervisor({ dialogs });

        await vi.advanceTimersByTimeAsync(longEnough);

        expect(store.events(runId)).toEqual([]);
        expect(sessionsView.failure()).toBeUndefined();
      },
    );

    it.each(["halt", "finish"] as const)(
      "stops polling after %s, so the engine's own kill is not a death",
      async (end) => {
        const sessionsView = supervisor();
        alive[androidTmux] = true;
        events.publish(bash(androidId));
        events.publish(agentCall("android", androidId));
        await vi.advanceTimersByTimeAsync(longEnough);

        if (end === "halt") sessionsView.halt();
        else await sessionsView.finish();
        alive[androidTmux] = false;
        const checksAtEnd = aliveChecks.length;
        await vi.advanceTimersByTimeAsync(longEnough);

        expect(aliveChecks.length).toBe(checksAtEnd);
        expect(statusOf("android-a1")).toBe("running");
        expect(sessionsView.failure()).toBeUndefined();
      },
    );
  });

  describe("finish()", () => {
    it("ends every started session still alive and appends nothing for it", async () => {
      const sessionsView = supervisor();
      alive[androidTmux] = true;
      events.publish(bash(androidId));
      events.publish(agentCall("android", androidId));
      const before = store.events(runId).length;

      await sessionsView.finish();

      expect(ended).toEqual([androidTmux]);
      expect(store.events(runId)).toHaveLength(before);
      expect(sessionsView.failure()).toBeUndefined();
    });

    it("ends a session still alive that never delivered a hook, appending nothing for it", async () => {
      const sessionsView = supervisor();
      alive[iosTmux] = true;

      await sessionsView.finish();

      expect(ended).toEqual([iosTmux]);
      expect(nodeEventsFor("ios")).toEqual([]);
      expect(sessionsView.started()).toEqual([]);
    });

    it("does not end a session that is no longer alive", async () => {
      const sessionsView = supervisor();

      await sessionsView.finish();

      expect(ended).toEqual([]);
    });
  });

  describe("trust and add-dir dialogs", () => {
    it("answers the dialogs once for a pre-assigned tmux name once it is alive", async () => {
      supervisor({ dialogs: true });
      await vi.advanceTimersByTimeAsync(longEnough);
      expect(answered).toEqual([]);

      alive[androidTmux] = true;
      await vi.advanceTimersByTimeAsync(longEnough);
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(answered).toEqual([androidTmux]);
    });

    it("fails that container when answering its dialogs fails, so failure() names it", async () => {
      const sessionsView = supervisor({ dialogs: "fail" });
      alive[androidTmux] = true;

      await vi.advanceTimersByTimeAsync(longEnough);
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(answered).toEqual([androidTmux]);
      expect(sessionsView.failure()).toMatchObject({ container: "android" });
      expect(statusOf("android-stop")).toBe("failed");
      expect(nodeEventsFor("ios")).toEqual([]);
    });

    it("records no failure when answering the dialogs fails after the engine ended the session itself", async () => {
      let refuse: (error: Error) => void = () => undefined;
      const sessionsView = supervisor({
        dialogs: new Promise<void>((_, reject) => {
          refuse = reject;
        }),
      });
      alive[androidTmux] = true;
      await vi.advanceTimersByTimeAsync(longEnough);
      expect(answered).toEqual([androidTmux]);

      await sessionsView.finish();
      refuse(new Error(`Session "${androidTmux}" does not exist`));
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(ended).toContain(androidTmux);
      expect(store.events(runId)).toEqual([]);
      expect(sessionsView.failure()).toBeUndefined();
    });

    it("never answers for a name that never comes alive", async () => {
      supervisor({ dialogs: true });
      alive[androidTmux] = true;

      await vi.advanceTimersByTimeAsync(longEnough);
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(answered).not.toContain(iosTmux);
    });
  });

  describe("session states", () => {
    const states = (android: string, ios: string) =>
      `${androidTmux} ${android}\n${iosTmux} ${ios}\n`;

    it("writes every session not-started when it begins watching", () => {
      supervisor();

      expect(writes).toEqual([states("not-started", "not-started")]);
    });

    it("writes a resumed session's state from its stored events", () => {
      const stored = (nodeId: string, kinds: ("running" | "done")[], from: number): StoredEvent[] =>
        kinds.map((kind, index) => ({ nodeId, kind, seq: from + index, time: "t" }));

      supervisor({
        history: [
          ...stored("android-start", ["running", "done"], 1),
          ...stored("android-a1", ["running", "done"], 3),
          ...stored("android-stop", ["running", "done"], 5),
          ...stored("ios-start", ["running", "done"], 7),
        ],
      });

      expect(writes).toEqual([states("done", "running")]);
    });

    it("writes a session done once its Stop is done, leaving the other unchanged", () => {
      supervisor();

      events.publish(bash(androidId));
      events.publish(agentDone("android", androidId));
      events.publish(stop(androidId));

      expect(writes.at(-1)).toBe(states("done", "not-started"));
    });

    it("writes a session running when it ends its turn with an agent left, then done after it", () => {
      supervisor();

      events.publish(agentCall("ios", iosId, "a1"));
      events.publish(agentDone("ios", iosId, "a1"));
      events.publish(stop(iosId));

      expect(writes.at(-1)).toBe(states("not-started", "running"));
      expect(statusOf("ios-stop")).toBe("waiting");

      events.publish(agentCall("ios", iosId, "a2"));
      events.publish(agentDone("ios", iosId, "a2"));
      events.publish(stop(iosId));

      expect(writes.at(-1)).toBe(states("not-started", "done"));
      expect(statusOf("ios-a2")).toBe("done");
    });

    it("writes a session failed on a StopFailure", () => {
      supervisor();

      events.publish(bash(iosId));
      events.publish(hookEvent("StopFailure", iosId, { error: "authentication_failed" }));

      expect(writes.at(-1)).toBe(states("not-started", "failed"));
    });

    it("writes a session failed when its tmux session is gone before its Stop", async () => {
      supervisor();
      alive[androidTmux] = true;
      events.publish(bash(androidId));
      events.publish(agentCall("android", androidId));
      await vi.advanceTimersByTimeAsync(longEnough);
      expect(writes.at(-1)).toBe(states("running", "not-started"));

      alive[androidTmux] = false;
      await vi.advanceTimersByTimeAsync(longEnough);

      expect(writes.at(-1)).toBe(states("failed", "not-started"));
    });

    it("writes a session failed at once when a Conditional Gate stops it, naming the Gate", () => {
      const android = container("session", "android", "/b/sessions/android/app", ["a1", "h"]);
      const conditionalGate: ManifestNode = {
        ...node("android-h", "gate", "Tests fail"),
        settings: { stopWhen: "conditional", condition: "tests fail", instruction: "" },
      };
      const stopping = {
        ...manifest,
        containers: manifest.containers.map((each) =>
          each.slug === "android"
            ? {
                ...android,
                nodes: android.nodes.map((n) =>
                  n.id === conditionalGate.id ? conditionalGate : n,
                ),
              }
            : each,
        ),
      } as LoadedBuild;
      store = new FakeStore();
      const sessionsView = supervisor({ build: stopping });

      events.publish(bash(androidId));
      events.publish(agentDone("android", androidId));
      events.publish(
        hookEvent("Stop", androidId, {
          last_assistant_message: "Failing.\nSTOPPED NODE android-h",
        }),
      );

      expect(writes.at(-1)).toBe(states("failed", "not-started"));
      expect(statusOf("android-stop")).toBe("waiting");
      expect(sessionsView.failure()).toEqual({ container: "android", node: "Tests fail" });
    });

    it("writes a session waiting while a permission is asked on its open node, then running", async () => {
      let decide: (reply: WaitReply) => void = () => undefined;
      supervisor({ replies: [new Promise<WaitReply>((resolve) => (decide = resolve))] });
      events.publish(agentCall("android", androidId));

      const decision = permissions.ask(androidId, {
        tool_name: "Bash",
        tool_input: { command: "git push" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.at(-1)).toBe(states("waiting", "not-started"));

      decide({ decision: "approve" });
      await decision;

      expect(writes.at(-1)).toBe(states("running", "not-started"));
    });

    it("writes nothing for an event that appends nothing", () => {
      supervisor();
      events.publish(agentCall("android", androidId));
      const before = writes.length;

      events.publish(stop(androidId));

      expect(writes).toHaveLength(before);
    });

    it("writes nothing after halt, and finish writes nothing", async () => {
      const sessionsView = supervisor();
      alive[androidTmux] = true;
      events.publish(bash(androidId));
      const before = writes.length;

      sessionsView.halt();
      sessionsView.failNode(androidId, "android-a1", "The run was stopped");
      await sessionsView.finish();

      expect(writes).toHaveLength(before);
    });
  });
});
