import { join } from "node:path";
import { hookEnvironment, workspaceTmuxVariable } from "../../core/compiler/hook-settings.js";
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
    attach,
    resume,
    env,
    ...layout
  }: OpenSessionOptions & { env?: Record<string, string> },
  { sessions, claude, sessionId }: { sessions: SessionHost; claude: ClaudeCli; sessionId: string },
): Promise<OpenedSession> {
  if (attach === true && !(await sessions.has(sessionName))) {
    throw new SessionGoneError(sessionName);
  }
  const buildFiles =
    layout.layout === "legacy"
      ? { settingsPath: join(buildDir, "settings.json"), pluginDirs: [buildDir] }
      : layout.workspaceFolder === cwd
        ? { settingsPath: "settings.json", pluginDirs: ["plugin"] }
        : {
            settingsPath: "../settings.json",
            pluginDirs: ["../plugin"],
            addDir: ["..", layout.workspaceFolder],
          };
  let closed = false;
  let started = attach === true;
  let starting: Promise<void> | undefined;
  const start = () =>
    claude
      .start(
        sessionName,
        cwd,
        { sessionId, name: sessionName, model, ...(resume === true ? { resume } : {}) },
        {
          ...buildFiles,
          env: {
            ...env,
            FLOWDECK_SOCK: socketPath,
            [workspaceTmuxVariable]: sessionName,
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
