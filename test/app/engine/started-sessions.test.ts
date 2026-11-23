import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartedSessions } from "../../../src/app/engine/started-sessions.js";
import type { ManifestContainer, ManifestNode } from "../../../src/core/compiler/lower.js";
import type { LoadedBuild, StartedSessionsView } from "../../../src/core/run/execute.js";
import { nodeStatus } from "../../../src/core/run/run-events.js";
import type { NodeState } from "../../../src/core/run/state.js";
import type { RunSession } from "../../../src/core/run/store.js";
import type { HookEvent, HookEventKind } from "../../../src/ports/event-source.js";
import type { WaitReply } from "../../../src/ports/waiter.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
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

const container = (
  kind: ManifestContainer["kind"],
  slug: string,
  worktree?: string,
): ManifestContainer => ({
  kind,
  name: slug,
  slug,
  prefix: `fix-login-${slug}`,
  ...(worktree === undefined ? {} : { worktree }),
  model: "haiku",
  nodes: [
    node(`${slug}-start`, "trigger", "Start"),
    node(`${slug}-a1`, "agent", "Plan"),
    node(`${slug}-stop`, "output", "Stop"),
  ],
  wires: [],
  orchestrator: `${slug}/orchestrator.md`,
});

const manifest = {
  version: 1,
  hash: "h1",
  layout: "workspace",
  cwd: "/b/workspace",
  containers: [
    container("workspace", "workspace"),
    container("session", "android", "/b/sessions/android/app"),
    container("session", "ios", "/b/sessions/ios/app"),
  ],
  files: {},
} as unknown as LoadedBuild;

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

const agentInput = (slug: string) => ({
  subagent_type: `fix-login-${slug}:${slug}-a1`,
  description: "Run",
  prompt: `NODE ${slug}-a1\nGo`,
});

const bash = (sessionId: string) =>
  hookEvent("PreToolUse", sessionId, { tool_name: "Bash", tool_input: { command: "ls" } });

const agentCall = (slug: string, sessionId: string) =>
  hookEvent("PreToolUse", sessionId, {
    tool_name: "Agent",
    tool_input: agentInput(slug),
    tool_use_id: `toolu-${slug}`,
  });

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

  const supervisor = ({
    dialogs = false,
    replies = [],
  }: {
    dialogs?: boolean | "fail" | Promise<void>;
    replies?: (WaitReply | Promise<WaitReply>)[];
  } = {}) => {
    waiter = new FakeWaiter(replies);
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
      manifest,
      sessions,
    });
  };

  const statusOf = (nodeId: string): NodeState =>
    nodeStatus(store.events(runId).filter((event) => event.nodeId === nodeId));

  const nodeEventsFor = (slug: string) =>
    store.events(runId).filter((event) => event.nodeId.startsWith(`${slug}-`));

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    runId = store.createRun({
      buildDir: "/b",
      inputs: {},
      nodeIds: manifest.containers.flatMap((each) => each.nodes.map(({ id }) => id)),
      session: { tmuxName: "fd-run-00000000", cwd: "/b/workspace", claudeSessionId: workspaceId },
      sessions,
      buildId: "b1",
    }).id;
    events = new FakeEventSource();
    permissions = new FakePermissionSource();
    alive = {};
    aliveChecks = [];
    ended = [];
    answered = [];
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
});
