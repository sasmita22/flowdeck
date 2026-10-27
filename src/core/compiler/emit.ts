import { canonicalJson } from "./canonical-json.js";
import { hookSettings } from "./hook-settings.js";
import type { BuildFile, lower } from "./lower.js";

export function emit(
  lowered: ReturnType<typeof lower>,
  hooks: { nodePath: string; hookScriptPath: string },
): BuildFile[] {
  const { session } = lowered.manifest;
  const settings = {
    permissions: { allow: session.allowedTools, defaultMode: session.permissionMode },
  };
  return [
    ...lowered.nodeFiles,
    { path: "settings.json", content: canonicalJson(settings) },
    { path: "hooks/hooks.json", content: canonicalJson(hookSettings(hooks)) },
    { path: "manifest.json", content: canonicalJson(lowered.manifest) },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
