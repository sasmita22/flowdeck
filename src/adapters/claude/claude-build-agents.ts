import { join } from "node:path";
import { agentCallOf, type AgentCall } from "../../core/run/agent-calls.js";
import { runSocketPath } from "../../core/run/execute.js";
import { turnFailure } from "../../core/run/turns.js";
import type {
  BuildAgents,
  BuildAgentsOpenSpec,
  BuildTurnResult,
} from "../../ports/build-agents.js";
import type { EventSource } from "../../ports/event-source.js";
import type { SessionHost } from "../../ports/session-host.js";
import type { ClaudeCli } from "./claude-cli.js";

export type BuildSessionEvents = { events: EventSource; stop: () => Promise<void> };

export type ClaudeBuildAgentsDeps = {
  home: string;
  sessions: (socketName: string) => SessionHost;
  cli: (sessions: SessionHost) => ClaudeCli;
  events: (socketPath: string) => Promise<BuildSessionEvents>;
  alivePollMs?: number;
};

export const defaultAlivePollMs = 2000;

export const buildSessionGoneReason = "the build session ended";

export function whenSessionGone(
  alive: () => Promise<boolean>,
  pollMs: number,
): { gone: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const gone = new Promise<void>((resolve) => {
    const poll = () => {
      timer = setTimeout(() => {
        void alive().then(
          (isAlive) => {
            if (cancelled) return;
            if (isAlive) poll();
            else resolve();
          },
          () => {
            if (!cancelled) poll();
          },
        );
      }, pollMs);
    };
    poll();
  });
  return {
    gone,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

type OpenSession = {
  sessionId: string;
  cli: ClaudeCli;
  socketPath: string;
  hooks?: BuildSessionEvents;
};

export class ClaudeBuildAgents implements BuildAgents {
  private readonly opened = new Map<string, OpenSession>();

  constructor(private readonly deps: ClaudeBuildAgentsDeps) {}

  async open({
    sessionName,
    claudeSessionId: sessionId,
    workspaceDir,
    kitDir,
    settingsPath,
    model,
    env,
    attach,
  }: BuildAgentsOpenSpec): Promise<void> {
    const socket = runSocketPath(this.deps.home, sessionName);
    if (socket.kind === "error") throw new Error(socket.message);
    const cli = this.deps.cli(this.deps.sessions(sessionName));
    if (attach === true) {
      this.opened.set(sessionName, { sessionId, cli, socketPath: socket.path });
      return;
    }
    const hooks = await this.deps.events(socket.path);
    this.opened.set(sessionName, { sessionId, cli, socketPath: socket.path, hooks });
    await cli.start(
      sessionName,
      workspaceDir,
      { sessionId, ...(model === undefined ? {} : { model }) },
      {
        settingsPath,
        pluginDirs: [join(workspaceDir, "plugin"), kitDir],
        env: {
          ...env,
          FLOWDECK_SOCK: socket.path,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        },
      },
    );
    await cli.waitUntilReady(sessionName);
  }

  async turn(
    sessionName: string,
    text: string,
    onCall: (call: AgentCall) => void,
  ): Promise<BuildTurnResult> {
    const session = this.opened.get(sessionName);
    if (session === undefined) {
      return { kind: "failed", reason: `build session ${sessionName} is not open` };
    }
    if (session.hooks === undefined) {
      const hooks = await this.deps.events(session.socketPath);
      if (this.opened.get(sessionName) !== session) {
        await hooks.stop();
        return { kind: "failed", reason: buildSessionGoneReason };
      }
      session.hooks = hooks;
      await session.cli.waitUntilReady(sessionName);
    }
    const { sessionId, cli, hooks } = session;
    const unsubscribe: (() => void)[] = [];
    const ended = new Promise<BuildTurnResult>((resolve) => {
      unsubscribe.push(
        hooks.events.subscribe("Stop", sessionId, () => resolve({ kind: "stopped" })),
        hooks.events.subscribe("StopFailure", sessionId, (event) =>
          resolve({ kind: "failed", reason: turnFailure(event).message }),
        ),
      );
    });
    for (const kind of ["PreToolUse", "PostToolUse"] as const) {
      unsubscribe.push(
        hooks.events.subscribe(kind, sessionId, (event) => {
          const call = agentCallOf(event);
          if (call !== undefined) onCall(call);
        }),
      );
    }
    const watch = whenSessionGone(
      () => this.alive(sessionName),
      this.deps.alivePollMs ?? defaultAlivePollMs,
    );
    unsubscribe.push(watch.cancel);
    const gone = watch.gone.then((): BuildTurnResult => ({
      kind: "failed",
      reason: buildSessionGoneReason,
    }));
    try {
      await cli.sendPrompt(sessionName, text);
      return await Promise.race([ended, gone]);
    } finally {
      for (const stop of unsubscribe) stop();
    }
  }

  async alive(sessionName: string): Promise<boolean> {
    return this.deps.sessions(sessionName).has(sessionName);
  }

  async close(sessionName: string): Promise<void> {
    const session = this.opened.get(sessionName);
    this.opened.delete(sessionName);
    await session?.hooks?.stop();
    const sessions = this.deps.sessions(sessionName);
    if (await sessions.has(sessionName)) await sessions.stop(sessionName);
  }
}
