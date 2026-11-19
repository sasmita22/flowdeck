import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { FileEntry, FileSystem } from "../../ports/file-system.js";

const hasCode = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && "code" in error && codes.includes(String(error.code));

export class NodeFileSystem implements FileSystem {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT", "ENOTDIR")) return false;
      throw error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  async writePrivateFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  async replaceFile(path: string, content: string): Promise<void> {
    const { mode } = await stat(path);
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await chmod(temp, mode & 0o7777);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async removeTree(path: string, { keep = [] }: { keep?: string[] } = {}): Promise<void> {
    if (keep.length === 0) {
      await rm(path, { recursive: true, force: true });
      return;
    }
    for (const name of await readdir(path)) {
      const child = join(path, name);
      if (keep.includes(child)) continue;
      const inside = keep.filter((kept) => kept.startsWith(child + sep));
      if (inside.length > 0) await this.removeTree(child, { keep: inside });
      else await rm(child, { recursive: true, force: true });
    }
  }

  async list(dir: string, { skip = [] }: { skip?: readonly string[] } = {}): Promise<string[]> {
    const files: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && !skip.includes(path)) await walk(path);
        else if (entry.isFile()) files.push(relative(dir, path).split(sep).join("/"));
      }
    };
    await walk(dir);
    return files.sort();
  }

  async folders(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  async realPath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      const parent = dirname(path);
      if (!hasCode(error, "ENOENT") || parent === path) throw error;
      return join(await this.realPath(parent), basename(path));
    }
  }

  async entries(dir: string, { inside }: { inside: string }): Promise<FileEntry[]> {
    const [folder, root] = await Promise.all([realpath(dir), realpath(inside)]);
    if (folder !== root && !folder.startsWith(root + sep)) {
      throw new Error(`${dir} is not inside ${inside}`);
    }
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    return [
      ...entries
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => ({ name, kind: "folder" as const })),
      ...entries
        .filter((entry) => entry.isFile())
        .map(({ name }) => ({ name, kind: "file" as const })),
    ];
  }
}
