import type { VariableValues } from "../flow/variables.js";
import { repoFolder } from "../run/workspace.js";
import { handoffFolderLine } from "../flow/handoff.js";
import { emptyReport } from "./build-report.js";
import { canonicalJson } from "./canonical-json.js";
import { guardHookFiles } from "./guard-hooks.js";
import { handoffTemplates } from "./handoff-templates.js";
import { sha256Hex } from "./hash.js";
import { buildHookCommand, hookSettings } from "./hook-settings.js";
import type { BuildFile, lower, Manifest } from "./lower.js";
import { orchestratorSkill } from "./orchestrator.js";
import { standardRules } from "./standard-rules.js";

export type EmitTarget = {
  blueprint?: { name: string; version: number };
  repo: string;
  base: string;
  branch: string;
  branchCreated: boolean;
  workspace?: string;
};

const byPath = (a: BuildFile, b: BuildFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function workspaceClaudeMd(
  build: { name: string; values: VariableValues },
  target: EmitTarget,
): string {
  const values = Object.entries(build.values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const branchMode = target.branchCreated ? `new from ${target.base}` : "existing";
  const summary = [
    `# Build ${build.name}`,
    "",
    ...(target.blueprint === undefined
      ? []
      : [`- Blueprint: ${target.blueprint.name}, version ${target.blueprint.version}`]),
    `- Repository folder: ${repoFolder(target.repo)}, relative to the workspace; run sessions start inside it`,
    "- Plugin folder: plugin/ in the workspace; run sessions reach it as ${CLAUDE_PLUGIN_ROOT}",
    `- ${handoffFolderLine(repoFolder(target.repo))}`,
    `- Target repo (read only while building): ${target.repo}`,
    `- Branch: ${target.branch} (${branchMode})`,
    ...values.map(([name, value]) => `- Variable ${name}: ${String(value)}`),
  ];
  return `${summary.join("\n")}\n\n${standardRules.text}`;
}

export const reportPath = "build-report.json";

export function emit(lowered: ReturnType<typeof lower>, target: EmitTarget): BuildFile[] {
  const { prefix, values, nodes } = lowered.manifest;
  const { permissionMode } = lowered.manifest.settings;
  const scope = { build: prefix, repo: repoFolder(target.repo), workspace: target.workspace ?? "" };
  const settings = {
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    permissions: { defaultMode: permissionMode },
    enableAllProjectMcpServers: true,
    ...(permissionMode === "bypassPermissions" ? { skipDangerousModePermissionPrompt: true } : {}),
  };
  const files: BuildFile[] = [
    ...lowered.nodeFiles,
    ...handoffTemplates({ nodes }, scope.repo),
    orchestratorSkill(lowered.manifest, scope),
    ...guardHookFiles(),
    { path: "settings.json", content: canonicalJson(settings) },
    { path: "plugin/hooks/hooks.json", content: canonicalJson(hookSettings(buildHookCommand)) },
    { path: "plugin/.claude-plugin/plugin.json", content: canonicalJson({ name: prefix }) },
    { path: "CLAUDE.md", content: workspaceClaudeMd({ name: prefix, values }, target) },
  ];
  const manifest: Manifest = {
    ...lowered.manifest,
    files: Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.content)])),
  };
  return [
    ...files,
    { path: reportPath, content: canonicalJson(emptyReport()) },
    { path: "manifest.json", content: canonicalJson(manifest) },
  ].sort(byPath);
}
