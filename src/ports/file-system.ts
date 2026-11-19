export type FileEntry = { name: string; kind: "folder" | "file" };

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  writePrivateFile(path: string, content: string): Promise<void>;
  replaceFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  list(dir: string, options?: { skip?: readonly string[] }): Promise<string[]>;
  folders(dir: string): Promise<string[]>;
  entries(dir: string, options: { inside: string }): Promise<FileEntry[]>;
  remove(path: string): Promise<void>;
  removeTree(path: string, options?: { keep?: string[] }): Promise<void>;
  realPath(path: string): Promise<string>;
}
