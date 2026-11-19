import { posix } from "node:path";
import type { FileEntry, FileSystem } from "../../src/ports/file-system.js";

export type FileSystemCall = {
  method:
    | "exists"
    | "writeFile"
    | "writePrivateFile"
    | "replaceFile"
    | "readFile"
    | "list"
    | "folders"
    | "entries"
    | "remove"
    | "removeTree"
    | "realPath";
  path: string;
  skip?: readonly string[];
};

export class FakeFileSystem implements FileSystem {
  readonly calls: FileSystemCall[] = [];
  private readonly files: Map<string, string>;
  private readonly privatePaths = new Set<string>();
  private readonly links = new Map<string, string>();

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

  async replaceFile(path: string, content: string): Promise<void> {
    this.calls.push({ method: "replaceFile", path });
    if (!this.files.has(path)) {
      throw Object.assign(new Error(`No such file: ${path}`), { code: "ENOENT" });
    }
    this.files.set(path, content);
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

  async removeTree(path: string, { keep = [] }: { keep?: string[] } = {}): Promise<void> {
    this.calls.push({ method: "removeTree", path });
    for (const child of this.under(path)) {
      const file = `${path}/${child}`;
      if (keep.some((kept) => file.startsWith(`${kept}/`))) continue;
      this.files.delete(file);
      this.privatePaths.delete(file);
    }
  }

  async list(dir: string, { skip }: { skip?: readonly string[] } = {}): Promise<string[]> {
    this.calls.push(
      skip === undefined ? { method: "list", path: dir } : { method: "list", path: dir, skip },
    );
    const files = this.under(dir);
    if (files.length === 0) {
      throw Object.assign(new Error(`ENOENT: no such directory, scandir '${dir}'`), {
        code: "ENOENT",
      });
    }
    const skipped = (file: string): boolean =>
      file
        .split("/")
        .slice(0, -1)
        .some((_, index, folders) =>
          (skip ?? []).includes(posix.join(dir, ...folders.slice(0, index + 1))),
        );
    return files.filter((file) => !skipped(file)).sort();
  }

  async folders(dir: string): Promise<string[]> {
    this.calls.push({ method: "folders", path: dir });
    const names = this.under(dir).flatMap((path) => {
      const slash = path.indexOf("/");
      return slash === -1 ? [] : [path.slice(0, slash)];
    });
    return [...new Set(names)].sort();
  }

  async entries(dir: string, { inside }: { inside: string }): Promise<FileEntry[]> {
    this.calls.push({ method: "entries", path: dir });
    const folder = posix.normalize(dir);
    const root = posix.normalize(inside);
    if (folder !== root && !folder.startsWith(`${root}/`)) {
      throw new Error(`${dir} is not inside ${inside}`);
    }
    const kinds = new Map<string, FileEntry["kind"]>();
    for (const path of this.under(folder)) {
      const slash = path.indexOf("/");
      kinds.set(slash === -1 ? path : path.slice(0, slash), slash === -1 ? "file" : "folder");
    }
    const named = (kind: FileEntry["kind"]): FileEntry[] =>
      [...kinds]
        .filter(([, entryKind]) => entryKind === kind)
        .map(([name]) => ({ name, kind }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    return [...named("folder"), ...named("file")];
  }

  link(path: string, real: string): void {
    this.links.set(path, real);
  }

  async realPath(path: string): Promise<string> {
    this.calls.push({ method: "realPath", path });
    for (const [link, real] of this.links) {
      if (path === link || path.startsWith(`${link}/`)) return real + path.slice(link.length);
    }
    return path;
  }

  private under(dir: string): string[] {
    const prefix = `${posix.normalize(dir)}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  }
}
