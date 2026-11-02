import { join } from "node:path";
import { hookEnvironment } from "../../core/compiler/hook-settings.js";
import type { ClaudeCli } from "./claude-cli.js";
import type { SessionHost } from "../../ports/session-host.js";
import type { OpenedSession, OpenSessionOptions } from "../../core/run/execute.js";

const stopped = () => new Error("The run was stopped");

export class SessionGoneError extends Error {
  constructor(sessionName: string) {
    super(`tmux session "${sessionName}" is gone; nothing was resent`);
    this.name = "SessionGoneError";
  }
}

export async function openClaudeSession(
  {
    sessionName,
    buildDir,
    model,
    socketPath,
    cwd,
    hooks,
    mcpConfigPath,
    attach,
    resume,
  }: OpenSessionOptions,
  { sessions, claude, sessionId }: { sessions: SessionHost; claude: ClaudeCli; sessionId: string },
): Promise<OpenedSession> {
  if (attach === true && !(await sessions.has(sessionName))) {
    throw new SessionGoneError(sessionName);
  }
  let closed = false;
  let started = attach === true;
  let starting: Promise<void> | undefined;
  const start = () =>
    claude
      .start(
        sessionName,
        cwd,
        { sessionId, model, ...(resume === true ? { resume } : {}) },
        {
          settingsPath: join(buildDir, "settings.json"),
          pluginDir: buildDir,
          ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
          env: {
            FLOWDECK_SOCK: socketPath,
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            ...hookEnvironment(hooks),
          },
        },
      )
      .then(() => {
        started = true;
      });
  return {
    sessionId,
    session: {
      ensureStarted: async () => {
        if (closed) throw stopped();
        if (attach !== true) {
          starting = start();
          await starting;
          if (closed) throw stopped();
        }
        await claude.waitUntilReady(sessionName);
      },
    },
    prompts: {
      sendPrompt: (text) => claude.sendPrompt(sessionName, text),
      interrupt: () => claude.interrupt(sessionName),
    },
    stop: async () => {
      closed = true;
      await starting?.catch(() => undefined);
      if (started && (await sessions.has(sessionName))) await sessions.stop(sessionName);
    },
  };
}
