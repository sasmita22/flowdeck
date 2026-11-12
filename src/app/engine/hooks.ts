import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type HooksResult =
  { kind: "ok"; nodePath: string; hookScriptPath: string } | { kind: "error"; message: string };

export type PreparedHooks =
  | (Extract<HooksResult, { kind: "ok" }> & { guardScriptPath: string; webGuardScriptPath: string })
  | Extract<HooksResult, { kind: "error" }>;

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const findNode = (pathEnv: string | undefined): string | undefined =>
  (pathEnv ?? "")
    .split(":")
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "node"))
    .find(isExecutable);

export function prepareHooks(options: {
  home: string;
  sourcePath: string;
  guardSourcePath: string;
  webGuardSourcePath: string;
  pathEnv: string | undefined;
}): PreparedHooks {
  const nodePath = findNode(options.pathEnv);
  if (nodePath === undefined) {
    return { kind: "error", message: "No executable node found on PATH; the Stop hook needs it" };
  }
  const hooksDir = join(options.home, "hooks");
  const hookScriptPath = join(hooksDir, basename(options.sourcePath));
  const guardScriptPath = join(hooksDir, basename(options.guardSourcePath));
  const webGuardScriptPath = join(hooksDir, basename(options.webGuardSourcePath));
  try {
    const script = readFileSync(options.sourcePath);
    const guard = readFileSync(options.guardSourcePath);
    const webGuard = readFileSync(options.webGuardSourcePath);
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookScriptPath, script);
    writeFileSync(guardScriptPath, guard);
    writeFileSync(webGuardScriptPath, webGuard);
  } catch (error) {
    return {
      kind: "error",
      message: `Could not prepare the Stop hook: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { kind: "ok", nodePath, hookScriptPath, guardScriptPath, webGuardScriptPath };
}
