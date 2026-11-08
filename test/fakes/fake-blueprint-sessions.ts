import type {
  BlueprintSessionSpec,
  BlueprintSessions,
} from "../../src/ports/blueprint-sessions.js";

export class FakeBlueprintSessions implements BlueprintSessions {
  readonly started: BlueprintSessionSpec[] = [];
  readonly stopped: string[] = [];
  private readonly running = new Set<string>();

  async start(spec: BlueprintSessionSpec): Promise<void> {
    this.started.push(spec);
    this.running.add(spec.session);
  }

  async stop(session: string): Promise<void> {
    if (!this.running.delete(session)) return;
    this.stopped.push(session);
  }

  async alive(session: string): Promise<boolean> {
    return this.running.has(session);
  }
}
