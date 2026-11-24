import type { VariableValues } from "../flow/variables.js";
import { repoFolder, sessionWorktree, workspaceFolder } from "../run/workspace.js";
import { handoffFolderLine } from "../flow/handoff.js";
import { emptyReport } from "./build-report.js";
import { canonicalJson } from "./canonical-json.js";
import { guardHookFiles } from "./guard-hooks.js";
import { handoffTemplates } from "./handoff-templates.js";
import { sha256Hex } from "./hash.js";
import {
  buildHookCommand,
  containerStartCommand,
  hookSettings,
  sessionEnvNames,
  type SessionEnvNames,
  sessionStatesVariable,
  workspaceTmuxVariable,
} from "./hook-settings.js";
import type { BuildFile, lower, Manifest, ManifestContainer } from "./lower.js";
import { orchestratorSkill } from "./orchestrator.js";
import { containerRoot } from "./pieces.js";
import { standardRules } from "./standard-rules.js";

export type ContainerBranch = { branch: string; branchCreated: boolean };

type SessionTarget = ContainerBranch & {
  blueprint?: { name: string; version: number };
  repo: string;
  base: string;
  workspace?: string;
};

export type EmitTarget = {
  blueprint?: { name: string; version: number };
  repo: string | null;
  base: string | null;
  branch: string | null;
  branchCreated: boolean | null;
  branches?: Readonly<Record<string, ContainerBranch>>;
  workspace?: string;
  realDir?: string;
};

const byPath = (a: BuildFile, b: BuildFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const sortedValues = (values: VariableValues) =>
  Object.entries(values)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `- Variable ${name}: ${String(value)}`);

const blueprintLine = (target: Pick<EmitTarget, "blueprint">) =>
  target.blueprint === undefined
    ? []
    : [`- Blueprint: ${target.blueprint.name}, version ${target.blueprint.version}`];

const withRules = (summary: readonly string[]) => `${summary.join("\n")}\n\n${standardRules.text}`;

export const replyFallbackLine =
  "- If you cannot go on without the reply, write the open question into your output and end your turn; the workspace's reply wakes you. Never wait inside a turn.";

export const namedSendLine =
  "- Send each message only to the name in the variable given for its session. If a send fails, never send it to another address, even one ListAgents shows: write the failed send and the message into your output, and end your turn if you cannot go on without it.";

const readOnlyWorkspace = (dir: string) => [
  `- Workspace folder (read only): ${workspaceFolder(dir)}; never edit or write files in it`,
  "- Changes the workspace needs go to the workspace session by message",
  "- Never ask or raise anything to the user; only the workspace session talks to the user",
  `- Send every issue, question and change the workspace needs to the workspace session with SendMessage, addressed to the name in the environment variable ${workspaceTmuxVariable}`,
  replyFallbackLine,
  namedSendLine,
];

export const connectedSessionsHeading = "## Connected sessions";

type Peer = { name: string; slug: string; tmux: string };

type Connections = readonly (readonly [string, string])[];

const peersOf = (
  slug: string,
  connections: Connections,
  containers: readonly ManifestContainer[],
  names: ReadonlyMap<string, SessionEnvNames>,
): Peer[] =>
  connections
    .flatMap(([a, b]) => (a === slug ? [b] : b === slug ? [a] : []))
    .sort()
    .flatMap((peer) => {
      const container = containers.find((candidate) => candidate.slug === peer);
      const env = names.get(peer);
      return container === undefined || env === undefined
        ? []
        : [{ name: container.name, slug: peer, tmux: env.tmux }];
    });

const peerSection = (peers: readonly Peer[]) =>
  peers.length === 0
    ? []
    : [
        "",
        connectedSessionsHeading,
        "",
        "- You may message these sessions directly with SendMessage, addressed to the name in the environment variable given for each",
        ...peers.map((peer) => `- ${peer.name} (${peer.slug}): ${peer.tmux}`),
      ];

export function workspaceClaudeMd(
  build: { name: string; values: VariableValues },
  target: SessionTarget,
  peers: readonly Peer[] = [],
): string {
  const branchMode = target.branchCreated ? `new from ${target.base}` : "existing";
  return withRules([
    `# Build ${build.name}`,
    "",
    ...blueprintLine(target),
    `- Repository folder: ${repoFolder(target.repo)}, in this session's own folder; run sessions start inside it`,
    "- Plugin folder: plugin/ in this session's own folder; run sessions reach it as ${CLAUDE_PLUGIN_ROOT}",
    `- ${handoffFolderLine(repoFolder(target.repo))}`,
    `- Target repo (read only while building): ${target.repo}`,
    `- Branch: ${target.branch} (${branchMode})`,
    ...(target.workspace === undefined ? [] : readOnlyWorkspace(target.workspace)),
    ...sortedValues(build.values),
    ...peerSection(peers),
  ]);
}

export const sessionEntryHeading = (container: Pick<ManifestContainer, "name" | "slug">) =>
  `### Session container ${container.name} (${container.slug})`;

const sessionList = (
  containers: readonly ManifestContainer[],
  buildDir: string,
  connections: Connections,
): string[] => {
  const names = sessionEnvNames(containers);
  const entries = containers.flatMap((container) => {
    const env = names.get(container.slug);
    if (container.kind !== "session" || env === undefined) return [];
    const command = containerStartCommand({
      container,
      buildDir,
      workspaceDir: workspaceFolder(buildDir),
      env,
      peers: peersOf(container.slug, connections, containers, names).map((peer) => peer.tmux),
    });
    return [
      "",
      sessionEntryHeading(container),
      "",
      `- Name: ${container.name}`,
      `- Repository: ${container.repo ?? ""}`,
      `- Branch: ${container.branch ?? ""}`,
      `- Worktree: ${container.worktree ?? ""}`,
      `- Model: ${container.model}`,
      `- Variables: ${env.tmux} holds its tmux name, ${env.id} its Claude session id`,
      "",
      "```sh",
      command,
      "```",
    ];
  });
  if (entries.length === 0) return [];
  return [
    "",
    "## Session containers",
    "",
    "- The workspace session's environment holds each container's variables below, set fresh for every run",
    "- Run a container's start command as written, from a shell, at most once per run; it returns at once, and the container then runs its own Start to Stop in its own tmux session",
    ...entries,
  ];
};

const pairList = (containers: readonly ManifestContainer[], connections: Connections) => {
  const label = (slug: string) =>
    `${containers.find((container) => container.slug === slug)?.name ?? slug} (${slug})`;
  return connections.length === 0
    ? []
    : [
        "",
        connectedSessionsHeading,
        "",
        "- Session containers joined by a connection may message each other directly",
        ...connections.map(([a, b]) => `- ${label(a)} and ${label(b)}`),
      ];
};

export const sessionStatesHeading = "## Session states";

const sessionStatesSection = (containers: readonly ManifestContainer[]) =>
  containers.some((container) => container.kind === "session")
    ? [
        "",
        sessionStatesHeading,
        "",
        `- \`$${sessionStatesVariable}\` names a file with one line per session container: its tmux name (the value of its \`FD_SESSION_<SLUG>_TMUX\`), then its state. Read it with \`cat "$${sessionStatesVariable}"\`.`,
        "- States: `not-started`, `running`, `waiting` (it waits for a permission answer), `done` (it reached its Stop), `failed` (it failed or its tmux ended before its Stop).",
        "- A session that sent you a question and ended its turn reads `running`; your reply wakes it.",
      ]
    : [];

const workspaceSessionClaudeMd = (
  build: { name: string; values: VariableValues },
  target: Pick<ContainerTarget, "blueprint" | "workspace">,
  containers: readonly ManifestContainer[],
  connections: Connections,
): string =>
  withRules([
    `# Build ${build.name}`,
    "",
    ...blueprintLine(target),
    "- This is the workspace session's folder; session containers read it but never write it",
    "- Plugin folder: plugin/ in this folder; run sessions reach it as ${CLAUDE_PLUGIN_ROOT}",
    "- Only this session talks to the user: raise every issue the sessions send here, coordinate the user and all sessions, and send each decision back to the session with SendMessage, addressed to the name in its tmux variable below",
    namedSendLine,
    ...sortedValues(build.values),
    ...sessionList(containers, target.workspace, connections),
    ...sessionStatesSection(containers),
    ...pairList(containers, connections),
  ]);

export const reportPath = "build-report.json";

const denyEditing = (dir: string) => {
  const path = `//${workspaceFolder(dir).replace(/^\/+/, "")}/**`;
  return [`Edit(${path})`, `Write(${path})`];
};

const workspaceDeny = (dir: string, realDir = dir) =>
  realDir === dir ? denyEditing(dir) : [...denyEditing(dir), ...denyEditing(realDir)];

type ContainerTarget = EmitTarget & { workspace: string };

const containerFiles = (
  container: ManifestContainer,
  build: { values: VariableValues; permissionMode: string },
  target: ContainerTarget,
  containers: readonly ManifestContainer[],
  connections: Connections,
): BuildFile[] => {
  const root = containerRoot(container);
  const session = container.kind === "session";
  const repo = session ? repoFolder(container.repo ?? "") : root;
  const scope = {
    build: container.prefix,
    repo,
    workspace: target.workspace,
    kind: container.kind,
  };
  const settings = {
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    permissions: {
      defaultMode: build.permissionMode,
      ...(session ? { deny: workspaceDeny(target.workspace, target.realDir) } : {}),
    },
    enableAllProjectMcpServers: true,
    ...(build.permissionMode === "bypassPermissions"
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
  };
  const named = { name: container.prefix, values: build.values };
  const claudeMd = session
    ? workspaceClaudeMd(
        named,
        {
          ...target,
          ...branchOf(container, target),
          repo: container.repo ?? "",
          base: container.base ?? target.base ?? "",
        },
        peersOf(container.slug, connections, containers, sessionEnvNames(containers)),
      )
    : workspaceSessionClaudeMd(named, target, containers, connections);
  const inRoot = (file: BuildFile): BuildFile => ({ ...file, path: `${root}/${file.path}` });
  return [
    ...handoffTemplates({ nodes: container.nodes }, repo).map(inRoot),
    orchestratorSkill(container, scope),
    ...guardHookFiles().map(inRoot),
    { path: `${root}/settings.json`, content: canonicalJson(settings) },
    {
      path: `${root}/plugin/hooks/hooks.json`,
      content: canonicalJson(hookSettings(buildHookCommand)),
    },
    {
      path: `${root}/plugin/.claude-plugin/plugin.json`,
      content: canonicalJson({ name: container.prefix }),
    },
    { path: `${root}/CLAUDE.md`, content: claudeMd },
  ];
};

const branchOf = (
  { slug }: Pick<ManifestContainer, "slug">,
  { branches, branch, branchCreated }: EmitTarget,
): ContainerBranch =>
  branches?.[slug] ?? { branch: branch ?? "", branchCreated: branchCreated ?? true };

const withWorktree = (container: ManifestContainer, target: ContainerTarget): ManifestContainer =>
  container.kind === "session" && container.repo !== undefined
    ? {
        ...container,
        branch: branchOf(container, target).branch,
        worktree: sessionWorktree(target.workspace, container.slug, container.repo),
      }
    : container;

export function emit(lowered: ReturnType<typeof lower>, target: ContainerTarget): BuildFile[] {
  const { values, settings } = lowered.manifest;
  const containers = lowered.manifest.containers.map((container) =>
    withWorktree(container, target),
  );
  const build = { values, permissionMode: settings.permissionMode };
  const files: BuildFile[] = [
    ...lowered.nodeFiles,
    ...containers.flatMap((container) =>
      containerFiles(container, build, target, containers, lowered.manifest.connections ?? []),
    ),
  ];
  const manifest: Manifest = {
    ...lowered.manifest,
    containers,
    files: Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.content)])),
  };
  return [
    ...files,
    { path: reportPath, content: canonicalJson(emptyReport()) },
    { path: "manifest.json", content: canonicalJson(manifest) },
  ].sort(byPath);
}
