import type { VariableValues } from "../flow/variables.js";
import { repoFolder, sessionWorktree, workspaceFolder } from "../run/workspace.js";
import { handoffFolderLine } from "../flow/handoff.js";
import { emptyReport } from "./build-report.js";
import { canonicalJson } from "./canonical-json.js";
import { guardHookFiles } from "./guard-hooks.js";
import { handoffTemplates } from "./handoff-templates.js";
import { sha256Hex } from "./hash.js";
import { buildHookCommand, hookSettings } from "./hook-settings.js";
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

const readOnlyWorkspace = (dir: string) => [
  `- Workspace folder (read only): ${workspaceFolder(dir)}; never edit or write files in it`,
  "- Changes the workspace needs go to the workspace session by message",
];

export function workspaceClaudeMd(
  build: { name: string; values: VariableValues },
  target: SessionTarget,
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
  ]);
}

const workspaceSessionClaudeMd = (
  build: { name: string; values: VariableValues },
  target: Pick<EmitTarget, "blueprint">,
): string =>
  withRules([
    `# Build ${build.name}`,
    "",
    ...blueprintLine(target),
    "- This is the workspace session's folder; session containers read it but never write it",
    "- Plugin folder: plugin/ in this folder; run sessions reach it as ${CLAUDE_PLUGIN_ROOT}",
    ...sortedValues(build.values),
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
    ? workspaceClaudeMd(named, {
        ...target,
        ...branchOf(container, target),
        repo: container.repo ?? "",
        base: container.base ?? target.base ?? "",
      })
    : workspaceSessionClaudeMd(named, target);
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
    ...containers.flatMap((container) => containerFiles(container, build, target)),
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
