export interface FileSystem {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
}
