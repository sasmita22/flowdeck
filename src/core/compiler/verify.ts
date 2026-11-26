import { hashBuild, sha256Hex } from "./hash.js";
import type { BuildFile } from "./lower.js";

export type VerifyFileSystem = {
  list(dir: string): Promise<string[]>;
  folders(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
};

type VerifyProblem = { path: string; problem: "changed" | "missing" | "extra" };

type VerifyResult = { ok: true } | { ok: false; problems: VerifyProblem[] };

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

const byPath = (a: VerifyProblem, b: VerifyProblem) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const pluginFolder = "plugin";
export const workspaceRootFiles = [manifestPath];
const containerRootFiles = ["CLAUDE.md", "settings.json"];

type Listing = { paths: string[]; read(path: string): Promise<string> };

async function listOrMissing(fs: VerifyFileSystem, dir: string): Promise<string[] | undefined> {
  try {
    return await fs.list(dir);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readOrMissing(fs: VerifyFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

const containerRoots = async (fs: VerifyFileSystem, dir: string): Promise<string[]> => [
  "workspace",
  ...(await fs.folders(`${dir}/sessions`)).map((slug) => `sessions/${slug}`),
];

export async function workspaceListing(
  fs: VerifyFileSystem,
  dir: string,
  rootFiles: readonly string[],
): Promise<Listing | undefined> {
  const root = new Map<string, string>();
  const plugins: string[] = [];
  for (const container of await containerRoots(fs, dir)) {
    const plugin = await listOrMissing(fs, `${dir}/${container}/${pluginFolder}`);
    if (plugin === undefined) continue;
    plugins.push(...plugin.map((path) => `${container}/${pluginFolder}/${path}`));
    for (const file of containerRootFiles) {
      const path = `${container}/${file}`;
      const content = await readOrMissing(fs, `${dir}/${path}`);
      if (content !== undefined) root.set(path, content);
    }
  }
  if (plugins.length === 0) return undefined;
  for (const path of rootFiles) {
    const content = await readOrMissing(fs, `${dir}/${path}`);
    if (content !== undefined) root.set(path, content);
  }
  return {
    paths: [...root.keys(), ...plugins],
    read: async (path) => root.get(path) ?? fs.readFile(`${dir}/${path}`),
  };
}

export async function verify(
  buildDir: string,
  expectedHash: string,
  deps: { fs: VerifyFileSystem },
): Promise<VerifyResult> {
  const listing = await workspaceListing(deps.fs, buildDir, workspaceRootFiles);
  if (listing === undefined) return manifestProblem("missing");
  const listed = listing.paths;
  if (!listed.includes(manifestPath)) return manifestProblem("missing");
  const manifestContent = await listing.read(manifestPath);
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
    const content = await listing.read(path);
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
    manifest.hash !== expectedHash ||
    (problems.length === 0 && hashBuild(read) !== manifest.hash);
  if (manifestChanged) {
    problems.push({ path: manifestPath, problem: "changed" });
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems: problems.sort(byPath) };
}
