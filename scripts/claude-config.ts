import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Settings = Record<string, unknown>;

export interface TempClaudeConfig {
  configDir: string;
  env: { CLAUDE_CONFIG_DIR: string; CLAUDE_SECURESTORAGE_CONFIG_DIR: string };
}

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function makeTempClaudeConfig(options: {
  root: string;
  home?: string;
  settings?: (settings: Settings) => Settings;
}): Promise<TempClaudeConfig> {
  const home = options.home ?? homedir();
  const configDir = join(options.root, ".claude");
  await mkdir(configDir, { recursive: true });

  const settings = await readIfPresent(join(home, ".claude", "settings.json"));
  if (settings !== undefined) {
    const transform = options.settings ?? ((same: Settings) => same);
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify(transform(JSON.parse(settings) as Settings), null, 2),
    );
  }
  try {
    await copyFile(join(home, ".claude.json"), join(configDir, ".claude.json"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  return { configDir, env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } };
}

const projectFolderOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

function keysAtAnyDepth(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysAtAnyDepth);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysAtAnyDepth(inner)]);
}

export async function claudeLeftovers(options: {
  roots: readonly string[];
  home?: string;
}): Promise<string[]> {
  const home = options.home ?? homedir();
  const projectsDir = join(home, ".claude", "projects");
  const claudeJson = join(home, ".claude.json");

  const folders = await readdir(projectsDir).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const slugs = options.roots.map(projectFolderOf);
  const projects = folders
    .filter((name) => slugs.some((slug) => name === slug || name.startsWith(`${slug}-`)))
    .map((name) => join(projectsDir, name));

  const text = await readIfPresent(claudeJson);
  const keys = text === undefined ? [] : keysAtAnyDepth(JSON.parse(text));
  const named = keys
    .filter((key) => options.roots.some((root) => key.includes(root)))
    .map((key) => `${claudeJson}:${key}`);

  return [...projects, ...named];
}
