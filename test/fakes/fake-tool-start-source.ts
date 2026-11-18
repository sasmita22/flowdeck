import type { ToolStartSource } from "../../src/ports/tool-start-source.js";

type Handler = (payload: Record<string, unknown>) => Promise<void>;

export class FakeToolStartSource implements ToolStartSource {
  private readonly handlers = new Map<string, Handler>();

  onToolStart(sessionId: string, handler: Handler): () => void {
    this.handlers.set(sessionId, handler);
    return () => {
      if (this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
    };
  }

  async start(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    await this.handlers.get(sessionId)?.(payload);
  }
}
