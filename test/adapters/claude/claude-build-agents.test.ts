import { assert, describe, expect, it, vi } from "vitest";
import {
  buildSessionGoneReason,
  ClaudeBuildAgents,
} from "../../../src/adapters/claude/claude-build-agents.js";
import { ClaudeCli } from "../../../src/adapters/claude/claude-cli.js";
import { agentCallOf, type AgentCall } from "../../../src/core/run/agent-calls.js";
import { runSocketPath } from "../../../src/core/run/execute.js";
import type { HookEvent } from "../../../src/ports/event-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";

const rule = "─".repeat(40);
const pane = (box: string) => [rule, `❯ ${box}`, rule].join("\n");
const home = "/fd";
const name = "fd-build-ab12cd34";
const spec = {
  sessionName: name,
  claudeSessionId: "3f2a1c4e-0000-4000-8000-000000000001",
  workspaceDir: "/fd/workspaces/alpha",
  kitDir: "/fd/kit/0123456789ab",
  settingsPath: "/fd/workspaces/alpha/build-settings.json",
  env: { FLOWDECK_HOOK_NODE: "/opt/node", FLOWDECK_HOOK_SCRIPT: "/fd/hooks/flowdeck-hook.cjs" },
};

class ClaudeLikeHost extends FakeSessionHost {
  private submitted: (() => void)[] = [];
  starts = 0;

  override async start(
    sessionName: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.starts++;
    await super.start(sessionName, cwd, command, env);
    this.setPane(sessionName, pane(""));
    this.onInput(sessionName, (input) => {
      if ("typed" in input) this.setPane(sessionName, pane(input.typed));
      if ("key" in input && input.key === "Enter") {
        this.setPane(sessionName, pane(""));
        const pending = this.submitted;
        this.submitted = [];
        for (const fire of pending) setTimeout(fire, 0);
      }
    });
  }

  afterSubmit(fire: () => void): void {
    this.submitted.push(fire);
  }
}

function harness() {
  const hosts = new Map<string, ClaudeLikeHost>();
  const socketNames: string[] = [];
  const socketPaths: string[] = [];
  const source = new FakeEventSource();
  let eventStops = 0;
  let eventsHeld: Promise<void> | undefined;
  const holdEvents = () => {
    let release: () => void = () => undefined;
    eventsHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  };
  const host = (socketName: string) => {
    socketNames.push(socketName);
    let found = hosts.get(socketName);
    if (found === undefined) {
      found = new ClaudeLikeHost();
      hosts.set(socketName, found);
    }
    return found;
  };
  const make = () =>
    new ClaudeBuildAgents({
      home,
      sessions: host,
      cli: (sessions) => new ClaudeCli({ sessions, pollIntervalMs: 1, readyTimeoutMs: 200 }),
      alivePollMs: 5,
      events: async (socketPath) => {
        socketPaths.push(socketPath);
        await eventsHeld;
        return {
          events: source,
          stop: async () => {
            eventStops++;
          },
        };
      },
    });
  const started = () => {
    const session = hosts.get(name)?.get(name);
    if (session === undefined) assert.fail(`no tmux session ${name} on socket ${name}`);
    return session;
  };
  const sessionId = () => {
    const id = /--session-id (\S+)/.exec(started().command)?.[1];
    if (id === undefined) assert.fail("launch command has no --session-id");
    return id;
  };
  const publish = (kind: HookEvent["kind"], payload: Record<string, unknown> = {}) =>
    source.publish({ kind, sessionId: sessionId(), payload });
  const afterSubmit = (fire: () => void) => {
    const found = hosts.get(name);
    if (found === undefined) assert.fail(`no host for socket ${name}`);
    found.afterSubmit(fire);
  };
  return {
    agents: make(),
    make,
    hosts,
    socketNames,
    socketPaths,
    eventStops: () => eventStops,
    holdEvents,
    started,
    sessionId,
    publish,
    afterSubmit,
  };
}

const socketPath = () => {
  const socket = runSocketPath(home, name);
  if (socket.kind === "error") throw new Error(socket.message);
  return socket.path;
};

describe("ClaudeBuildAgents", () => {
  describe("open", () => {
    it("starts the session on a tmux socket named after it, in the workspace dir", async () => {
      const t = harness();

      await t.agents.open(spec);

      expect(t.socketNames).toContain(name);
      expect(t.socketNames.every((socketName) => socketName === name)).toBe(true);
      expect(await t.hosts.get(name)?.list()).toEqual([name]);
      expect(t.started().cwd).toBe(spec.workspaceDir);
    });

    it("starts one hook socket for the session at its run socket path", async () => {
      const t = harness();

      await t.agents.open(spec);

      expect(t.socketPaths).toEqual([socketPath()]);
    });

    it("launches Claude with the build settings and the workspace plugin then the kit", async () => {
      const t = harness();

      await t.agents.open(spec);

      const command = t.started().command;
      expect(command).toContain(" claude --session-id ");
      expect(command).toContain(" --settings '/fd/workspaces/alpha/build-settings.json'");
      expect(command).toContain(
        " --plugin-dir '/fd/workspaces/alpha/plugin' --plugin-dir '/fd/kit/0123456789ab'",
      );
      expect(command.match(/--plugin-dir/g)).toHaveLength(2);
    });

    it("passes the model when one is set", async () => {
      const t = harness();

      await t.agents.open({ ...spec, model: "haiku" });

      expect(t.started().command).toContain(" --model 'haiku'");
    });

    it("passes no model flag when none is set", async () => {
      const t = harness();

      await t.agents.open(spec);

      expect(t.started().command).toContain(" claude --session-id ");
      expect(t.started().command).not.toContain("--model");
    });

    it("gives Claude the hook socket, background tasks off, and the spec's env", async () => {
      const t = harness();

      await t.agents.open(spec);

      expect(t.started().env).toEqual({
        ...spec.env,
        FLOWDECK_SOCK: socketPath(),
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      });
    });
  });

  describe("turn", () => {
    it("types the text into Claude and submits it", async () => {
      const t = harness();
      await t.agents.open(spec);
      t.afterSubmit(() => t.publish("Stop"));

      await t.agents.turn(name, "PIECE agents/a.md", () => undefined);

      const inputs = t.hosts.get(name)?.inputs(name) ?? [];
      expect(inputs).toContainEqual({ typed: "PIECE agents/a.md" });
      expect(inputs.at(-1)).toEqual({ key: "Enter" });
    });

    it("resolves stopped on the session's Stop", async () => {
      const t = harness();
      await t.agents.open(spec);
      t.afterSubmit(() => t.publish("Stop"));

      await expect(t.agents.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "stopped",
      });
    });

    it("resolves failed with the failure's reason on the session's StopFailure", async () => {
      const t = harness();
      await t.agents.open(spec);
      t.afterSubmit(() => t.publish("StopFailure", { error: "rate_limit" }));

      await expect(t.agents.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "failed",
        reason: "rate_limit",
      });
    });

    it("resolves failed once the build session has ended mid-turn", async () => {
      const t = harness();
      await t.agents.open(spec);
      t.afterSubmit(() => void t.hosts.get(name)?.stop(name));

      const result = await Promise.race([
        t.agents.turn(name, "PIECE agents/a.md", () => undefined),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
      ]);

      expect(result).toEqual({ kind: "failed", reason: "the build session ended" });
    });

    it("keeps waiting while the build session is alive", async () => {
      const t = harness();
      await t.agents.open(spec);
      t.afterSubmit(() => setTimeout(() => t.publish("Stop"), 50));

      await expect(t.agents.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "stopped",
      });
    });

    it("resolves failed for a session it has not opened", async () => {
      const t = harness();

      await expect(t.agents.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "failed",
        reason: `build session ${name} is not open`,
      });
    });

    it("does not take a failed liveness check for the session ending", async () => {
      const t = harness();
      await t.agents.open(spec);
      const host = t.hosts.get(name);
      if (host === undefined) assert.fail(`no host for socket ${name}`);
      const has = vi.spyOn(host, "has").mockRejectedValueOnce(new Error("tmux busy"));
      t.afterSubmit(() => setTimeout(() => t.publish("Stop"), 50));

      await expect(t.agents.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "stopped",
      });
      await expect(has.mock.results[0]?.value).rejects.toThrow("tmux busy");
    });

    it("keeps checking after a failed liveness check, and fails once the session has ended", async () => {
      const t = harness();
      await t.agents.open(spec);
      const host = t.hosts.get(name);
      if (host === undefined) assert.fail(`no host for socket ${name}`);
      vi.spyOn(host, "has").mockRejectedValueOnce(new Error("tmux busy"));
      t.afterSubmit(() => setTimeout(() => void host.stop(name), 30));

      const result = await Promise.race([
        t.agents.turn(name, "PIECE agents/a.md", () => undefined),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
      ]);

      expect(result).toEqual({ kind: "failed", reason: buildSessionGoneReason });
    });

    it("reports each Agent call before and after it runs, through agentCallOf", async () => {
      const t = harness();
      await t.agents.open(spec);
      const pre = {
        tool_name: "Agent",
        tool_use_id: "tu-1",
        tool_input: { prompt: "PIECE agents/a.md\nKIND agent", subagent_type: "x" },
      };
      const post = {
        ...pre,
        tool_response: {
          agentType: "flowdeck-build:piece-auditor",
          agentId: "ag-1",
          status: "completed",
        },
      };
      t.afterSubmit(() => {
        t.publish("PreToolUse", pre);
        t.publish("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/x" } });
        t.publish("PostToolUse", post);
        t.publish("Stop");
      });
      const calls: AgentCall[] = [];

      await t.agents.turn(name, "PIECE agents/a.md", (call) => calls.push(call));

      const expected = [
        agentCallOf({ kind: "PreToolUse", payload: pre }),
        agentCallOf({ kind: "PostToolUse", payload: post }),
      ];
      expect(expected.every((call) => call?.piece === "agents/a.md")).toBe(true);
      expect(calls).toEqual(expected);
    });
  });

  describe("attach", () => {
    it("attaches to a session left going without starting Claude, and sends the next turn there", async () => {
      const t = harness();
      await t.agents.open(spec);
      const restarted = t.make();

      await expect(restarted.open({ ...spec, attach: true })).resolves.toBeUndefined();

      expect(t.hosts.get(name)?.starts).toBe(1);
      expect(t.socketPaths).toEqual([socketPath()]);
      t.afterSubmit(() => t.publish("Stop"));
      await expect(restarted.turn(name, "PIECE agents/a.md", () => undefined)).resolves.toEqual({
        kind: "stopped",
      });
      expect(t.socketPaths).toEqual([socketPath(), socketPath()]);
      expect(t.hosts.get(name)?.inputs(name)).toContainEqual({ typed: "PIECE agents/a.md" });
    });

    it("stops the hook socket a first turn bound after its session was closed, and fails the turn", async () => {
      const t = harness();
      await t.agents.open(spec);
      const restarted = t.make();
      await restarted.open({ ...spec, attach: true });
      const stopsBefore = t.eventStops();
      const release = t.holdEvents();

      const turning = restarted.turn(name, "PIECE agents/a.md", () => undefined);
      await vi.waitFor(() => expect(t.socketPaths).toHaveLength(2));
      await restarted.close(name);
      release();

      await expect(turning).resolves.toEqual({ kind: "failed", reason: buildSessionGoneReason });
      expect(t.eventStops()).toBe(stopsBefore + 1);
    });
  });

  describe("alive and close", () => {
    it("is alive once open, and not after close", async () => {
      const t = harness();
      await t.agents.open(spec);

      expect(await t.agents.alive(name)).toBe(true);
      await t.agents.close(name);

      expect(await t.agents.alive(name)).toBe(false);
    });

    it("close stops the tmux session and the session's hook socket", async () => {
      const t = harness();
      await t.agents.open(spec);

      await t.agents.close(name);

      expect(await t.hosts.get(name)?.list()).toEqual([]);
      expect(t.eventStops()).toBe(1);
    });

    it("reaches a session it did not open through the tmux socket named after it", async () => {
      const t = harness();
      await t.agents.open(spec);
      const restarted = t.make();
      t.socketNames.length = 0;

      expect(await restarted.alive(name)).toBe(true);
      await restarted.close(name);

      expect(t.socketNames.every((socketName) => socketName === name)).toBe(true);
      expect(t.socketNames.length).toBeGreaterThan(0);
      expect(await t.hosts.get(name)?.list()).toEqual([]);
    });
  });
});
