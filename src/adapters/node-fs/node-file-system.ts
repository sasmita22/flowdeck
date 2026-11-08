import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileSystem } from "../../ports/file-system.js";

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

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async removeTree(path: string, { keep }: { keep?: string } = {}): Promise<void> {
    if (keep === undefined) {
      await rm(path, { recursive: true, force: true });
      return;
    }
    for (const name of await readdir(path)) {
      const child = join(path, name);
      if (child === keep) continue;
      if (keep.startsWith(child + sep)) await this.removeTree(child, { keep });
      else await rm(child, { recursive: true, force: true });
    }
  }

  async list(dir: string, { skip }: { skip?: string } = {}): Promise<string[]> {
    const files: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && path !== skip) await walk(path);
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
}
