export interface FileSystem {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  writePrivateFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}
