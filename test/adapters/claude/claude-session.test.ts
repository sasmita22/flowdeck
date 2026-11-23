import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCli } from "../../../src/adapters/claude/claude-cli.js";
import {
  openClaudeSession,
  SessionGoneError,
} from "../../../src/adapters/claude/claude-session.js";
import { layDown, workspaceDir } from "../../../src/core/compiler/build.js";
import { legacyBranchName } from "../../../src/core/run/branch-name.js";
import { containerPrefix } from "../../../src/core/compiler/pieces.js";
import {
  sessionFolder,
  sessionWorktree,
  workspaceFolder,
} from "../../../src/core/run/workspace.js";
import { FakeSessionHost } from "../../fakes/fake-session-host.js";
import { agent, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const rule = "─".repeat(40);
const readyPane = [rule, "❯ ", rule].join("\n");
const options = {
  sessionName: "fd-run",
  buildDir: "/fd/builds/abc",
  model: "haiku",
  socketPath: "/fd/sockets/fd-run.sock",
  cwd: "/repo",
  claudeSessionId: "s1",
  hooks: { nodePath: "/opt/my node/bin/node", hookScriptPath: "/fd/hooks/flowdeck-hook.cjs" },
  layout: "legacy" as const,
};

const workspace = {
  ...options,
  buildDir: "/fd/workspaces/b1",
  cwd: "/fd/workspaces/b1/carousell-web",
  layout: "workspace" as const,
  workspaceFolder: "/fd/workspaces/b1/workspace",
};

class SlowStartHost extends FakeSessionHost {
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  startCalls = 0;

  override async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.startCalls++;
    await this.gate;
    await super.start(name, cwd, command, env);
    this.setPane(name, readyPane);
  }

  finishStart(): void {
    this.release();
  }
}

class RecordingHost extends FakeSessionHost {
  readonly calls: string[] = [];

  override async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    this.calls.push("start");
    await super.start(name, cwd, command, env);
  }

  override async has(name: string): Promise<boolean> {
    this.calls.push("has");
    return super.has(name);
  }

  override async stop(name: string): Promise<void> {
    this.calls.push("stop");
    await super.stop(name);
  }

  override async capture(name: string): Promise<string> {
    this.calls.push("capture");
    return super.capture(name);
  }

  override async typeText(name: string, text: string): Promise<void> {
    this.calls.push("typeText");
    await super.typeText(name, text);
  }
}

function open(sessions: FakeSessionHost, attach = false) {
  const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
  return openClaudeSession({ ...options, attach }, { sessions, claude, sessionId: "s1" });
}

describe("openClaudeSession", () => {
  it("starts Claude with the build as plugin folder and the hook paths in its environment, and stops it", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    sessions.finishStart();

    await opened.session.ensureStarted();

    expect(sessions.get("fd-run")?.command).toContain("--plugin-dir '/fd/builds/abc'");
    expect(sessions.get("fd-run")?.env).toEqual({
      FLOWDECK_SOCK: "/fd/sockets/fd-run.sock",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      FLOWDECK_HOOK_NODE: "/opt/my node/bin/node",
      FLOWDECK_HOOK_SCRIPT: "/fd/hooks/flowdeck-hook.cjs",
    });
    await opened.stop();
    expect(await sessions.list()).toEqual([]);
  });

  it("passes no MCP config when the run has none", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    sessions.finishStart();

    await opened.session.ensureStarted();

    expect(sessions.get("fd-run")?.command).not.toContain("--mcp-config");
    await opened.stop();
  });

  it("waits for a start in flight when stopped, then stops the session it made", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    const starting = opened.session.ensureStarted();
    const stopping = opened.stop();

    sessions.finishStart();
    await stopping;

    expect(await sessions.list()).toEqual([]);
    await expect(starting).rejects.toThrow("The run was stopped");
  });

  it("refuses to start once stopped", async () => {
    const sessions = new SlowStartHost();
    const opened = await open(sessions);
    sessions.finishStart();
    await opened.stop();

    await expect(opened.session.ensureStarted()).rejects.toThrow("The run was stopped");
    expect(sessions.startCalls).toBe(0);
  });

  it("does nothing on stop when Claude was never started", async () => {
    const sessions = new SlowStartHost();

    await (await open(sessions)).stop();

    expect(sessions.startCalls).toBe(0);
  });

  it("restarts the conversation in a new session with --resume and the build's flags", async () => {
    const sessions = new SlowStartHost();
    const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
    const opened = await openClaudeSession(
      { ...options, resume: true },
      { sessions, claude, sessionId: "s1" },
    );
    sessions.finishStart();

    await opened.session.ensureStarted();

    const command = sessions.get("fd-run")?.command ?? "";
    expect(command).toContain(" claude --resume s1 --model 'haiku'");
    expect(command).toContain(" --settings '/fd/builds/abc/settings.json'");
    expect(command).toMatch(/ --plugin-dir '\/fd\/builds\/abc'$/);
    expect(sessions.get("fd-run")?.env?.["FLOWDECK_SOCK"]).toBe("/fd/sockets/fd-run.sock");
    await opened.stop();
  });

  describe("for a workspace build", () => {
    const openWorkspace = (overrides: { resume?: boolean } = {}) => {
      const sessions = new SlowStartHost();
      const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
      const opened = openClaudeSession(
        { ...workspace, ...overrides },
        { sessions, claude, sessionId: "s1" },
      );
      sessions.finishStart();
      return { sessions, opened };
    };

    it("starts Claude in the worktree, reading the workspace above it", async () => {
      const { sessions, opened } = openWorkspace();
      const session = await opened;

      await session.session.ensureStarted();

      expect(sessions.get("fd-run")?.cwd).toBe("/fd/workspaces/b1/carousell-web");
      const command = sessions.get("fd-run")?.command ?? "";
      expect(command).toContain(" --add-dir '..'");
      expect(command).toContain(" --settings '../settings.json'");
      expect(command).toContain(" --plugin-dir '../plugin'");
      expect(command).not.toMatch(/'\/fd\/workspaces\/b1\/(settings\.json|plugin)'/);
      await session.stop();
    });

    describe("in the container layout", () => {
      const dir = "/fd/workspaces/b1";
      const startCommand = async (cwd: string) => {
        const sessions = new SlowStartHost();
        const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
        const opened = openClaudeSession(
          { ...workspace, buildDir: dir, cwd, workspaceFolder: `${dir}/workspace` },
          { sessions, claude, sessionId: "s1" },
        );
        sessions.finishStart();
        const session = await opened;
        await session.session.ensureStarted();
        const command = sessions.get("fd-run")?.command ?? "";
        await session.stop();
        expect(command).toContain(" claude --session-id s1");
        return command;
      };

      it("starts a session container reading its own folder and the workspace", async () => {
        const command = await startCommand(`${dir}/sessions/web/carousell-web`);

        expect(command).toContain(" --settings '../settings.json'");
        expect(command).toContain(" --plugin-dir '../plugin'");
        expect(command).toContain(" --add-dir '..' --add-dir '/fd/workspaces/b1/workspace'");
      });

      it("adds no workspace folder when starting the workspace container", async () => {
        const command = await startCommand(`${dir}/workspace`);

        expect(command).not.toContain("--add-dir '/fd/workspaces/b1/workspace'");
      });
    });

    it("keeps the workspace flags when it resumes the conversation", async () => {
      const { sessions, opened } = openWorkspace({ resume: true });
      const session = await opened;

      await session.session.ensureStarted();

      const command = sessions.get("fd-run")?.command ?? "";
      expect(command).toContain(" claude --resume s1 --model 'haiku'");
      expect(command).toContain(" --add-dir '..'");
      expect(command).toContain(" --plugin-dir '../plugin'");
      await session.stop();
    });
  });

  describe("for two builds made from one blueprint", () => {
    const home = "/fd";
    const repo = "/src/carousell-web";
    const blueprint = onMainFlow([agent("p"), agent("a")], [thenWire("p", "a")]);
    const builds = [
      { id: "b-alpha-0001-2222", name: "alpha" },
      { id: "b-beta-0003-4444", name: "beta" },
    ];

    const launch = async (
      build: { id: string; name: string },
      {
        cwdOf = (dir: string) => sessionWorktree(dir, "main", repo),
        env,
      }: { cwdOf?: (dir: string) => string; env?: Record<string, string> } = {},
    ) => {
      const branch = legacyBranchName(build.name, build.id);
      const laidDown = await layDown(blueprint, {
        home,
        workspace: {
          ...build,
          repo,
          base: "main",
          branch,
          branchCreated: true,
          values: {},
          blueprint: { name: "shared", version: 1 },
        },
      });
      if (!laidDown.ok) throw new Error(JSON.stringify(laidDown.errors));
      const dir = workspaceDir(home, build.id);
      const cwd = cwdOf(dir);
      const sessions = new SlowStartHost();
      const claude = new ClaudeCli({ sessions, pollIntervalMs: 2, readyTimeoutMs: 100 });
      const opened = await openClaudeSession(
        {
          ...workspace,
          sessionName: `fd-run-${build.name}`,
          buildDir: dir,
          cwd,
          workspaceFolder: `${dir}/workspace`,
          ...(env === undefined ? {} : { env }),
        },
        { sessions, claude, sessionId: "s1" },
      );
      sessions.finishStart();
      await opened.session.ensureStarted();
      const started = sessions.get(`fd-run-${build.name}`);
      const command = started?.command ?? "";
      await opened.stop();
      const files = new Map(laidDown.files.map((file) => [`${dir}/${file.path}`, file.content]));
      return { dir, cwd, command, files, startedIn: started?.cwd, startedEnv: started?.env };
    };

    const pluginDirs = (command: string) =>
      [...command.matchAll(/ --plugin-dir '([^']*)'/g)].map((match) => match[1] ?? "");

    it("gives each run exactly one plugin folder, its own build's ../plugin", async () => {
      for (const build of builds) {
        const { dir, cwd, command } = await launch(build);

        expect(pluginDirs(command)).toEqual(["../plugin"]);
        expect(resolve(cwd, "../plugin")).toBe(`${sessionFolder(dir, "main")}/plugin`);
      }
    });

    it("loads a plugin named after its own build", async () => {
      for (const build of builds) {
        const { cwd, command, files } = await launch(build);
        const [pluginDir] = pluginDirs(command);
        const manifest = files.get(resolve(cwd, pluginDir ?? "", ".claude-plugin/plugin.json"));

        expect(manifest).toBeDefined();
        expect(JSON.parse(manifest ?? "{}")).toEqual({ name: containerPrefix(build.name, "main") });
      }
    });

    it("opens the workspace session in the workspace folder with its own settings, plugin and env", async () => {
      const sessionEnv = {
        FD_SESSION_MAIN_TMUX: "fd-run-0000000a",
        FD_SESSION_MAIN_ID: "c2",
        CLAUDE_CONFIG_DIR: "/fd/claude-config",
      };
      for (const build of builds) {
        const { dir, command, files, startedIn, startedEnv } = await launch(build, {
          cwdOf: workspaceFolder,
          env: sessionEnv,
        });

        const folder = workspaceFolder(dir);
        const settings = command.match(/ --settings '([^']*)'/)?.[1] ?? "";
        const [pluginDir = ""] = pluginDirs(command);
        expect(startedIn).toBe(folder);
        expect(resolve(folder, settings)).toBe(`${folder}/settings.json`);
        expect(files.has(resolve(folder, settings))).toBe(true);
        expect(pluginDirs(command)).toHaveLength(1);
        expect(resolve(folder, pluginDir)).toBe(`${folder}/plugin`);
        expect(files.has(resolve(folder, pluginDir, ".claude-plugin/plugin.json"))).toBe(true);
        expect(startedEnv).toMatchObject(sessionEnv);
        expect(startedEnv?.["FLOWDECK_SOCK"]).toBe(workspace.socketPath);
      }
    });

    it("never names the other build's workspace", async () => {
      const [alpha, beta] = await Promise.all(builds.map((build) => launch(build)));

      expect(alpha?.command).not.toContain(beta?.dir);
      expect(alpha?.command).not.toContain(builds[1]?.id);
      expect(beta?.command).not.toContain(alpha?.dir);
      expect(beta?.command).not.toContain(builds[0]?.id);
    });
  });

  describe("for an old hash-named build", () => {
    it("starts Claude with the build folder as plugin folder and its settings, adding no folder", async () => {
      const sessions = new SlowStartHost();
      const opened = await open(sessions);
      sessions.finishStart();

      await opened.session.ensureStarted();

      const command = sessions.get("fd-run")?.command ?? "";
      expect(sessions.get("fd-run")?.cwd).toBe("/repo");
      expect(command).toContain(" --settings '/fd/builds/abc/settings.json'");
      expect(command).toContain(" --plugin-dir '/fd/builds/abc'");
      expect(command).not.toContain("--add-dir");
      await opened.stop();
    });
  });

  describe("attached to a session that is already running", () => {
    it("never starts Claude, waits until it is ready, and stops the session on stop", async () => {
      const sessions = new RecordingHost();
      await sessions.start("fd-run", "/repo", "claude");
      sessions.setPane("fd-run", readyPane);
      sessions.calls.length = 0;

      const opened = await open(sessions, true);
      await opened.session.ensureStarted();

      expect(sessions.calls).toEqual(["has", "capture"]);
      await opened.stop();
      expect(sessions.calls).not.toContain("start");
      expect(await sessions.list()).toEqual([]);
    });

    it("refuses a session that is gone and asks nothing else of tmux", async () => {
      const sessions = new RecordingHost();

      await expect(open(sessions, true)).rejects.toThrow(SessionGoneError);
      await expect(open(sessions, true)).rejects.toThrow('"fd-run"');
      expect(sessions.calls).toEqual(["has", "has"]);
    });
  });
});
