import { assertSessionName } from "../../src/adapters/tmux/tmux-session-host.js";
import type { SessionHost } from "../../src/ports/session-host.js";

export class FakeSessionHost implements SessionHost {
  private readonly sessions = new Map<string, { cwd: string; command: string }>();

  async start(name: string, cwd: string, command: string): Promise<void> {
    assertSessionName(name);
    if (this.sessions.has(name)) throw new Error(`Session "${name}" already exists`);
    this.sessions.set(name, { cwd, command });
  }

  async has(name: string): Promise<boolean> {
    assertSessionName(name);
    return this.sessions.has(name);
  }

  async stop(name: string): Promise<void> {
    assertSessionName(name);
    if (!this.sessions.delete(name)) throw new Error(`Session "${name}" does not exist`);
  }

  async list(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  get(name: string): { cwd: string; command: string } | undefined {
    return this.sessions.get(name);
  }
}
