import type { FileSystem } from "../../src/ports/file-system.js";

export type FileSystemCall = {
  method: "exists" | "writeFile" | "readFile" | "list";
  path: string;
};

export class FakeFileSystem implements FileSystem {
  readonly calls: FileSystemCall[] = [];
  private readonly files: Map<string, string>;

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
  }

  async readFile(path: string): Promise<string> {
    this.calls.push({ method: "readFile", path });
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`No such file: ${path}`);
    return content;
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

  private under(dir: string): string[] {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  }
}
