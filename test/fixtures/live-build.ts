import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ClaudeBuildAgents } from "../../src/adapters/claude/claude-build-agents.js";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { HookSocketServer } from "../../src/adapters/hook-socket/hook-socket-server.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { realDeps, runCli, type CliDeps } from "../../src/cli/main.js";
import type { Flow } from "../../src/core/flow/schema.js";
import type { PendingBuildEnd } from "../../src/core/run/store.js";
import type { BuildAgents, BuildAgentsOpenSpec } from "../../src/ports/build-agents.js";
import { killTmuxServer, removeClaudeSessions } from "./live-claude.js";

export const draftsOnly = process.env.FLOWDECK_LIVE_DRAFTS === "1";

export type LiveBuildResult = {
  code: number;
  stdout: string[];
  stderr: string[];
  ends: PendingBuildEnd[];
  workspaceDir: string | undefined;
  files: ReadonlyMap<string, string>;
};

const keptFiles = (path: string) =>
  path.startsWith("plugin/") || ["manifest.json", "build-report.json", "CLAUDE.md"].includes(path);

async function readWorkspace(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice(dir.length + 1);
    if (keptFiles(path)) files.set(path, await readFile(join(dir, path), "utf8"));
  }
  return files;
}

const draftAgents: BuildAgents = {
  open: async () => {},
  turn: async () => ({ kind: "stopped" }),
  alive: async () => true,
  close: async () => {},
};

export function realBuildAgents(home: string): ClaudeBuildAgents {
  return new ClaudeBuildAgents({
    home,
    sessions: (socketName) => new TmuxSessionHost({ socketName }),
    cli: (sessions) => new ClaudeCli({ sessions }),
    events: async (socketPath) => {
      await mkdir(dirname(socketPath), { recursive: true });
      const server = new HookSocketServer({ socketPath });
      await server.start();
      return { events: server, stop: () => server.stop() };
    },
  });
}

export async function sessionIdsIn(folder: string): Promise<string[]> {
  const slug = folder.replace(/[^a-zA-Z0-9]/g, "-");
  try {
    return (await readdir(join(homedir(), ".claude", "projects", slug)))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.replace(/\.jsonl$/, ""));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export class LiveBuilds {
  private readonly agents: BuildAgents;
  private readonly opened: BuildAgentsOpenSpec[] = [];
  private readonly ends: PendingBuildEnd[] = [];
  private readonly closedFiles = new Map<string, Map<string, string>>();

  constructor(private readonly home: string) {
    this.agents = draftsOnly ? draftAgents : realBuildAgents(home);
  }

  deps(): CliDeps {
    const real = realDeps();
    const agents = this.agents;
    return {
      ...real,
      env: { ...process.env, FLOWDECK_HOME: this.home },
      openStore: (path) => {
        const stores = real.openStore(path);
        const end = stores.runs.endPendingBuild.bind(stores.runs);
        stores.runs.endPendingBuild = (pendingId, value) => {
          this.ends.push(value);
          end(pendingId, value);
        };
        return stores;
      },
      build: {
        ...real.build,
        agents: {
          open: async (spec) => {
            this.opened.push(spec);
            await agents.open(spec);
          },
          turn: (name, text, onCall) => agents.turn(name, text, onCall),
          alive: (name) => agents.alive(name),
          close: async (name) => {
            const spec = this.opened.find((open) => open.sessionName === name);
            if (spec !== undefined) {
              this.closedFiles.set(name, await readWorkspace(spec.workspaceDir));
            }
            await agents.close(name);
          },
        },
      },
    };
  }

  async build(
    flow: Flow,
    request: { name: string; repo: string },
    deps: CliDeps = this.deps(),
  ): Promise<LiveBuildResult> {
    const flowPath = join(this.home, `${request.name}.flow.json`);
    await writeFile(flowPath, JSON.stringify(flow));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const before = this.opened.length;
    const endsBefore = this.ends.length;
    const code = await runCli(["build", flowPath, "--name", request.name, "--repo", request.repo], {
      ...deps,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    const spec = this.opened.slice(before).at(-1);
    const result: LiveBuildResult = {
      code,
      stdout,
      stderr,
      ends: this.ends.slice(endsBefore),
      workspaceDir: spec?.workspaceDir,
      files: (spec && this.closedFiles.get(spec.sessionName)) ?? new Map(),
    };
    console.log(
      [
        `build ${request.name} exited ${code}`,
        `stdout:\n${stdout.join("\n")}`,
        `stderr:\n${stderr.join("\n")}`,
        `ends: ${JSON.stringify(result.ends)}`,
        `files: ${[...result.files.keys()].join(", ")}`,
      ].join("\n"),
    );
    return result;
  }

  async cleanup(): Promise<void> {
    for (const spec of this.opened) {
      await this.agents.close(spec.sessionName);
      await killTmuxServer(spec.sessionName);
      await removeClaudeSessions(spec.workspaceDir, [spec.claudeSessionId]);
    }
  }
}

export const workFolderOf = (workspaceDir: string, repo: string) =>
  join(workspaceDir, basename(repo));
