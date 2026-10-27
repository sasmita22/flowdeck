import { assertSessionName } from "../../src/adapters/tmux/tmux-session-host.js";
import type { SessionHost, SessionKey } from "../../src/ports/session-host.js";

export type SessionInput = { text: string } | { key: SessionKey };

type FakeSession = {
  cwd: string;
  command: string;
  env: Record<string, string> | undefined;
  inputs: SessionInput[];
  pane: string;
  listeners: ((input: SessionInput) => void)[];
};

export class FakeSessionHost implements SessionHost {
  private readonly sessions = new Map<string, FakeSession>();

  async start(
    name: string,
    cwd: string,
    command: string,
    env?: Record<string, string>,
  ): Promise<void> {
    assertSessionName(name);
    if (this.sessions.has(name)) throw new Error(`Session "${name}" already exists`);
    this.sessions.set(name, { cwd, command, env, inputs: [], pane: "", listeners: [] });
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

  get(
    name: string,
  ): { cwd: string; command: string; env: Record<string, string> | undefined } | undefined {
    const session = this.sessions.get(name);
    return session && { cwd: session.cwd, command: session.command, env: session.env };
  }

  async sendText(name: string, text: string): Promise<void> {
    this.record(name, { text });
  }

  async sendKey(name: string, key: SessionKey): Promise<void> {
    this.record(name, { key });
  }

  async capture(name: string): Promise<string> {
    return this.session(name).pane;
  }

  inputs(name: string): SessionInput[] {
    return [...this.session(name).inputs];
  }

  setPane(name: string, pane: string): void {
    this.session(name).pane = pane;
  }

  onInput(name: string, listener: (input: SessionInput) => void): void {
    this.session(name).listeners.push(listener);
  }

  private record(name: string, input: SessionInput): void {
    const session = this.session(name);
    session.inputs.push(input);
    for (const listener of session.listeners) listener(input);
  }

  private session(name: string): FakeSession {
    assertSessionName(name);
    const session = this.sessions.get(name);
    if (!session) throw new Error(`Session "${name}" does not exist`);
    return session;
  }
}
