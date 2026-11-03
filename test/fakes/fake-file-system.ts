import type { FileSystem } from "../../src/ports/file-system.js";

export type FileSystemCall = {
  method:
    | "exists"
    | "writeFile"
    | "writePrivateFile"
    | "readFile"
    | "list"
    | "folders"
    | "remove"
    | "removeTree";
  path: string;
};

export class FakeFileSystem implements FileSystem {
  readonly calls: FileSystemCall[] = [];
  private readonly files: Map<string, string>;
  private readonly privatePaths = new Set<string>();

  constructor(seed: Record<string, string> = {}) {
    this.files = new Map(Object.entries(seed));
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push({ method: "exists", path });
    return this.files.has(path) || this.under(path).length > 0;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ method: "writeFile", path });
    this.files.set(path, content);
    this.privatePaths.delete(path);
  }

  async writePrivateFile(path: string, content: string): Promise<void> {
    this.calls.push({ method: "writePrivateFile", path });
    this.files.set(path, content);
    this.privatePaths.add(path);
  }

  isPrivate(path: string): boolean {
    return this.privatePaths.has(path);
  }

  async readFile(path: string): Promise<string> {
    this.calls.push({ method: "readFile", path });
    const content = this.files.get(path);
    if (content === undefined) {
      throw Object.assign(new Error(`No such file: ${path}`), { code: "ENOENT" });
    }
    return content;
  }

  async remove(path: string): Promise<void> {
    this.calls.push({ method: "remove", path });
    this.files.delete(path);
    this.privatePaths.delete(path);
  }

  async removeTree(path: string, { keep }: { keep?: string } = {}): Promise<void> {
    this.calls.push({ method: "removeTree", path });
    for (const child of this.under(path)) {
      const file = `${path}/${child}`;
      if (keep !== undefined && file.startsWith(`${keep}/`)) continue;
      this.files.delete(file);
      this.privatePaths.delete(file);
    }
  }

  async list(dir: string): Promise<string[]> {
    this.calls.push({ method: "list", path: dir });
    const files = this.under(dir);
    if (files.length === 0) {
      throw Object.assign(new Error(`ENOENT: no such directory, scandir '${dir}'`), {
        code: "ENOENT",
      });
    }
    return files.sort();
  }

  async folders(dir: string): Promise<string[]> {
    this.calls.push({ method: "folders", path: dir });
    const names = this.under(dir).flatMap((path) => {
      const slash = path.indexOf("/");
      return slash === -1 ? [] : [path.slice(0, slash)];
    });
    return [...new Set(names)].sort();
  }

  private under(dir: string): string[] {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  }
}
