export type SessionKey = "Down" | "Enter";

export interface SessionHost {
  start(name: string, cwd: string, command: string, env?: Record<string, string>): Promise<void>;
  has(name: string): Promise<boolean>;
  stop(name: string): Promise<void>;
  list(): Promise<string[]>;
  sendText(name: string, text: string): Promise<void>;
  typeText(name: string, text: string): Promise<void>;
  sendKey(name: string, key: SessionKey): Promise<void>;
  capture(name: string): Promise<string>;
}
