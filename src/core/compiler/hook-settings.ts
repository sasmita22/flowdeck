import { sessionFolder, sessionWorktree } from "../run/workspace.js";
import { noForcePushPath, rulesAfterCompactPath } from "./guard-hooks.js";
import type { ManifestContainer } from "./lower.js";

type HookEntry = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
}[];

export type HookSettings = {
  hooks: {
    Stop: HookEntry;
    PreToolUse: HookEntry;
    PostToolUse: HookEntry;
    PostToolUseFailure: HookEntry;
    SubagentStop: HookEntry;
    StopFailure: HookEntry;
    PermissionRequest: HookEntry;
    SessionStart: HookEntry;
  };
};

export const permissionHookTimeoutSeconds = 86_400;

const permissionDeadlineMs = (permissionHookTimeoutSeconds - 60) * 1000;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type HookPaths = { nodePath: string; hookScriptPath: string };

const nodeVariable = "FLOWDECK_HOOK_NODE";
const scriptVariable = "FLOWDECK_HOOK_SCRIPT";

export const buildHookCommand = `[ -z "$${nodeVariable}" ] || [ -z "$${scriptVariable}" ] || "$${nodeVariable}" "$${scriptVariable}"`;

export function hookEnvironment(paths: HookPaths): Record<string, string> {
  return { [nodeVariable]: paths.nodePath, [scriptVariable]: paths.hookScriptPath };
}

export function hookCommand(paths: HookPaths): string {
  return `${shellQuote(paths.nodePath)} ${shellQuote(paths.hookScriptPath)}`;
}

const guard = (matcher: string, script: string): HookEntry[number] => ({
  matcher,
  hooks: [{ type: "command", command: `bash "\${CLAUDE_PLUGIN_ROOT}/${script}"` }],
});

export function hookSettings(command: string): HookSettings {
  const entry: HookEntry = [{ hooks: [{ type: "command", command }] }];
  const permission: HookEntry = [
    {
      hooks: [
        {
          type: "command",
          command: `${command} --permission-deadline-ms=${permissionDeadlineMs}`,
          timeout: permissionHookTimeoutSeconds,
        },
      ],
    },
  ];
  return {
    hooks: {
      Stop: entry,
      PreToolUse: [...entry, guard("Bash", noForcePushPath.replace(/^plugin\//, ""))],
      PostToolUse: entry,
      PostToolUseFailure: entry,
      SubagentStop: entry,
      StopFailure: entry,
      PermissionRequest: permission,
      SessionStart: [guard("compact", rulesAfterCompactPath.replace(/^plugin\//, ""))],
    },
  };
}

export const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
] as const;

export type ClaudeSession = { sessionId: string; model?: string; resume?: boolean; name?: string };

export function claudeCommand(
  { sessionId, model, resume, name }: ClaudeSession,
  settingsPath?: string,
  pluginDirs: readonly string[] = [],
  mcpConfigPath?: string,
  addDir: readonly string[] = [],
): string {
  const unset = PARENT_SESSION_VARS.map((name) => `-u ${name}`).join(" ");
  const settings = settingsPath === undefined ? "" : ` --settings ${shellQuote(settingsPath)}`;
  const plugin = pluginDirs.map((dir) => ` --plugin-dir ${shellQuote(dir)}`).join("");
  const modelFlag = model === undefined ? "" : ` --model ${shellQuote(model)}`;
  const mcp =
    mcpConfigPath === undefined
      ? ""
      : ` --mcp-config ${shellQuote(mcpConfigPath)} --strict-mcp-config`;
  const added = addDir.map((dir) => ` --add-dir ${shellQuote(dir)}`).join("");
  const session = resume === true ? `--resume ${sessionId}` : `--session-id ${sessionId}`;
  const nameFlag = name === undefined ? "" : ` --name ${name}`;
  return `env ${unset} claude ${session}${nameFlag}${modelFlag}${settings}${plugin}${added}${mcp}`;
}

export type SessionEnvNames = { tmux: string; id: string };

const envSlug = (slug: string) => slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export function sessionEnvNames(
  containers: readonly Pick<ManifestContainer, "kind" | "slug">[],
): Map<string, SessionEnvNames> {
  const taken = new Set<string>();
  const names = new Map<string, SessionEnvNames>();
  for (const { kind, slug } of containers) {
    if (kind !== "session") continue;
    const base = `FD_SESSION_${envSlug(slug)}`;
    let stem = base;
    for (let n = 2; taken.has(stem); n += 1) stem = `${base}_${n}`;
    taken.add(stem);
    names.set(slug, { tmux: `${stem}_TMUX`, id: `${stem}_ID` });
  }
  return names;
}

export const workspaceTmuxVariable = "FD_WORKSPACE_TMUX";

const forwardedVariables = [
  "FLOWDECK_SOCK",
  nodeVariable,
  scriptVariable,
  workspaceTmuxVariable,
] as const;

export function containerStartCommand({
  container,
  buildDir,
  workspaceDir,
  env,
  peers = [],
}: {
  container: ManifestContainer;
  buildDir: string;
  workspaceDir: string;
  env: SessionEnvNames;
  peers?: readonly string[];
}): string {
  const folder = sessionFolder(buildDir, container.slug);
  const worktree =
    container.worktree ?? sessionWorktree(buildDir, container.slug, container.repo ?? "");
  const tmux = `"$${env.tmux}"`;
  const forwarded = [
    ...[...forwardedVariables, ...[...peers].sort()].map((name) => `-e ${name}="$${name}"`),
    "-e CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
  ].join(" ");
  const claude = claudeCommand(
    { sessionId: `"$${env.id}"`, name: tmux, model: container.model },
    `${folder}/settings.json`,
    [`${folder}/plugin`],
    undefined,
    [workspaceDir],
  );
  return `tmux -L ${tmux} new-session -d -s ${tmux} -c ${shellQuote(worktree)} ${forwarded} ${claude} ${shellQuote(`/${container.prefix}:run`)}`;
}
