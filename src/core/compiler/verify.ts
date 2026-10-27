import { hashBuild, sha256Hex } from "./hash.js";
import type { BuildFile } from "./lower.js";

export type VerifyFileSystem = {
  list(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
};

export type VerifyProblem = { path: string; problem: "changed" | "missing" | "extra" };

export type VerifyResult = { ok: true } | { ok: false; problems: VerifyProblem[] };

const manifestPath = "manifest.json";

type RecordedManifest = { hash: unknown; files: Record<string, string> };

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseManifest = (content: string): RecordedManifest | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.files)) return undefined;
  if (!Object.values(parsed.files).every((value) => typeof value === "string")) return undefined;
  return { hash: parsed.hash, files: parsed.files as Record<string, string> };
};

const manifestProblem = (problem: VerifyProblem["problem"]): VerifyResult => ({
  ok: false,
  problems: [{ path: manifestPath, problem }],
});

const folderName = (dir: string): string => dir.replace(/\/+$/, "").split("/").at(-1) ?? "";

const byPath = (a: VerifyProblem, b: VerifyProblem) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export async function verify(
  buildDir: string,
  deps: { fs: VerifyFileSystem },
): Promise<VerifyResult> {
  let listed: string[];
  try {
    listed = await deps.fs.list(buildDir);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return manifestProblem("missing");
    throw error;
  }
  if (!listed.includes(manifestPath)) return manifestProblem("missing");
  const manifestContent = await deps.fs.readFile(`${buildDir}/${manifestPath}`);
  const manifest = parseManifest(manifestContent);
  if (manifest === undefined) return manifestProblem("changed");

  const problems: VerifyProblem[] = [];
  const read: BuildFile[] = [{ path: manifestPath, content: manifestContent }];
  for (const [path, recorded] of Object.entries(manifest.files)) {
    if (path === manifestPath) continue;
    if (!listed.includes(path)) {
      problems.push({ path, problem: "missing" });
      continue;
    }
    const content = await deps.fs.readFile(`${buildDir}/${path}`);
    read.push({ path, content });
    if (sha256Hex(content) !== recorded) problems.push({ path, problem: "changed" });
  }
  for (const path of listed) {
    if (path !== manifestPath && !Object.hasOwn(manifest.files, path)) {
      problems.push({ path, problem: "extra" });
    }
  }
  const manifestChanged =
    Object.hasOwn(manifest.files, manifestPath) ||
    manifest.hash !== folderName(buildDir) ||
    (problems.length === 0 && hashBuild(read) !== manifest.hash);
  if (manifestChanged) {
    problems.push({ path: manifestPath, problem: "changed" });
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems: problems.sort(byPath) };
}
