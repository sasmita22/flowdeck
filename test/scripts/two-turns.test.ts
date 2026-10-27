import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { hookSettings } from "../../src/core/compiler/hook-settings.js";
import type { HookEvent } from "../../src/ports/event-source.js";
import {
  driveTwoTurns,
  sendTwoTurns,
  twoTurnsPrompts,
  twoTurnsSettings,
} from "../../scripts/two-turns.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeSessionHost } from "../fakes/fake-session-host.js";

const rule = "─".repeat(40);
const readyPane = ["╭─ Claude Code ─╮", rule, "❯ ", rule, "  ? for shortcuts"].join("\n");
const flushTasks = () => new Promise((resolve) => setImmediate(resolve));
const stop = (sessionId: string, turn: string): HookEvent => ({
  kind: "Stop",
  sessionId,
  payload: { turn },
});

describe("twoTurnsSettings", () => {
  it("adds acceptEdits to the hook settings so the Write tool runs without a prompt", () => {
    expect(twoTurnsSettings({ nodePath: "/n", hookScriptPath: "/h" })).toEqual({
      ...hookSettings({ nodePath: "/n", hookScriptPath: "/h" }),
      permissions: { defaultMode: "acceptEdits" },
    });
  });
});

describe("twoTurnsPrompts", () => {
  it("has A write the token to a.txt with the Write tool", () => {
    const token = randomUUID();

    const { a } = twoTurnsPrompts(token);

    expect(a).toContain(token);
    expect(a).toContain("a.txt");
    expect(a).toContain("Write tool");
  });

  it("has B copy a.txt to b.txt with the Write tool without being told the token", () => {
    const token = randomUUID();

    const { b } = twoTurnsPrompts(token);

    expect(b).toContain("a.txt");
    expect(b).toContain("b.txt");
    expect(b).toContain("Write tool");
    expect(b).not.toContain(token);
  });
});

describe("sendTwoTurns", () => {
  const name = "fd-a";
  const sessionId = "s1";
  const prompts = { a: "prompt A", b: "prompt B" };
  let host: FakeSessionHost;
  let claude: ClaudeCli;
  let events: FakeEventSource;
  const texts = () => host.inputs(name).flatMap((input) => ("text" in input ? [input.text] : []));

  beforeEach(async () => {
    host = new FakeSessionHost();
    await host.start(name, "/work", "claude");
    host.setPane(name, readyPane);
    claude = new ClaudeCli({ sessions: host, pollIntervalMs: 2 });
    await claude.waitUntilReady(name);
    events = new FakeEventSource();
  });

  it("sends B only after A's Stop and resolves with both Stops after B's", async () => {
    const stopA = stop(sessionId, "a");
    const stopB = stop(sessionId, "b");

    const turns = sendTwoTurns({ claude, events, name, sessionId, prompts, turnTimeoutMs: 1000 });
    await vi.waitFor(() => expect(texts()).toEqual([prompts.a]));
    await flushTasks();
    expect(texts()).toEqual([prompts.a]);

    events.publish(stopA);
    await vi.waitFor(() => expect(texts()).toEqual([prompts.a, prompts.b]));
    events.publish(stopB);

    expect(await turns).toEqual([stopA, stopB]);
  });

  it("does not send B on a Stop from another session", async () => {
    const turns = sendTwoTurns({ claude, events, name, sessionId, prompts, turnTimeoutMs: 1000 });
    await vi.waitFor(() => expect(texts()).toEqual([prompts.a]));

    events.publish(stop("s2", "a"));
    await flushTasks();

    expect(texts()).toEqual([prompts.a]);
    events.publish(stop(sessionId, "a"));
    await vi.waitFor(() => expect(texts()).toEqual([prompts.a, prompts.b]));
    events.publish(stop(sessionId, "b"));
    await turns;
  });

  it("catches a Stop that arrives while the prompt is still being sent", async () => {
    const stopA = stop(sessionId, "a");
    const stopB = stop(sessionId, "b");
    host.onInput(name, (input) => {
      if ("text" in input && input.text === prompts.a) events.publish(stopA);
      if ("text" in input && input.text === prompts.b) events.publish(stopB);
    });

    const turns = sendTwoTurns({ claude, events, name, sessionId, prompts, turnTimeoutMs: 50 });

    expect(await turns).toEqual([stopA, stopB]);
  });

  it("rejects without sending B when A's Stop does not arrive in time", async () => {
    const turns = sendTwoTurns({ claude, events, name, sessionId, prompts, turnTimeoutMs: 20 });

    await expect(turns).rejects.toThrow(`no Stop for session ${sessionId} within 20 ms`);
    expect(texts()).toEqual([prompts.a]);
  });
});

class ReadyHost extends FakeSessionHost {
  constructor(private readonly onStarted: (name: string) => void = () => undefined) {
    super();
  }

  override async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await super.start(name, cwd, command, env);
    this.setPane(name, readyPane);
    this.onStarted(name);
  }
}

describe("driveTwoTurns", () => {
  const settingsPath = "/home/sessions/s1/settings.json";
  const env = { FLOWDECK_SOCK: "/home/hook.sock" };
  let events: FakeEventSource;
  let closeEvents: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    events = new FakeEventSource();
    closeEvents = vi.fn(async () => undefined);
  });

  function answeringHost(sessionId: string) {
    const seen: { text: string; session: ReturnType<FakeSessionHost["get"]> }[] = [];
    const host: ReadyHost = new ReadyHost((name) =>
      host.onInput(name, (input) => {
        if (!("text" in input)) return;
        seen.push({ text: input.text, session: host.get(name) });
        events.publish(stop(sessionId, input.text));
      }),
    );
    return { host, seen };
  }

  function drive(options: {
    host: FakeSessionHost;
    name: string;
    sessionId: string;
    turnTimeoutMs?: number;
    readyTimeoutMs?: number;
  }) {
    return driveTwoTurns({
      claude: new ClaudeCli({
        sessions: options.host,
        pollIntervalMs: 2,
        readyTimeoutMs: options.readyTimeoutMs ?? 1000,
      }),
      sessions: options.host,
      events,
      closeEvents,
      name: options.name,
      cwd: "/work",
      session: { sessionId: options.sessionId, model: "haiku" },
      startOptions: { settingsPath, env },
      turnTimeoutMs: options.turnTimeoutMs ?? 1000,
    });
  }

  it("runs both turns in a session started with the settings and env, then stops it", async () => {
    const { host, seen } = answeringHost("s1");

    const result = await drive({ host, name: "fd-run", sessionId: "s1" });

    expect(seen).toHaveLength(2);
    expect(result.stops).toEqual(seen.map(({ text }) => stop("s1", text)));
    expect(seen[0]?.text).toContain(result.token);
    expect(seen[0]?.session?.command).toContain(settingsPath);
    expect(seen[0]?.session?.env).toEqual(env);
    expect(await host.list()).toEqual([]);
    expect(closeEvents).toHaveBeenCalledOnce();
  });

  it("stops the session and the events when a turn does not end", async () => {
    const host = new ReadyHost();

    await expect(
      drive({ host, name: "fd-run", sessionId: "s1", turnTimeoutMs: 20 }),
    ).rejects.toThrow("no Stop for session s1 within 20 ms");
    expect(await host.list()).toEqual([]);
    expect(closeEvents).toHaveBeenCalledOnce();
  });

  it("stops the session and the events when Claude is never ready", async () => {
    const host = new FakeSessionHost();

    await expect(
      drive({ host, name: "fd-run", sessionId: "s1", readyTimeoutMs: 20 }),
    ).rejects.toThrow('Claude in session "fd-run" was not ready within 20 ms');
    expect(await host.list()).toEqual([]);
    expect(closeEvents).toHaveBeenCalledOnce();
  });

  it("sends a fresh token on every run", async () => {
    const first = answeringHost("s1");
    const second = answeringHost("s2");

    const one = await drive({ host: first.host, name: "fd-one", sessionId: "s1" });
    const two = await drive({ host: second.host, name: "fd-two", sessionId: "s2" });

    expect(one.token).not.toBe(two.token);
    expect(first.seen[0]?.text).toContain(one.token);
    expect(second.seen[0]?.text).toContain(two.token);
  });
});
