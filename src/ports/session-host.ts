export interface SessionHost {
  start(name: string, cwd: string, command: string): Promise<void>;
  has(name: string): Promise<boolean>;
  stop(name: string): Promise<void>;
  list(): Promise<string[]>;
}
