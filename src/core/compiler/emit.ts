import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./hash.js";
import { hookSettings } from "./hook-settings.js";
import type { BuildFile, lower, Manifest } from "./lower.js";

const byPath = (a: BuildFile, b: BuildFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function emit(
  lowered: ReturnType<typeof lower>,
  hooks: { nodePath: string; hookScriptPath: string },
): BuildFile[] {
  const { session } = lowered.manifest;
  const settings = {
    permissions: { allow: session.allowedTools, defaultMode: session.permissionMode },
  };
  const files: BuildFile[] = [
    ...lowered.nodeFiles,
    { path: "settings.json", content: canonicalJson(settings) },
    { path: "hooks/hooks.json", content: canonicalJson(hookSettings(hooks)) },
  ];
  const manifest: Manifest = {
    ...lowered.manifest,
    files: Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.content)])),
  };
  return [...files, { path: "manifest.json", content: canonicalJson(manifest) }].sort(byPath);
}
