import type { PermissionDecision, PermissionSource } from "../../src/ports/permission-source.js";

type Handler = (
  payload: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<PermissionDecision>;

export class FakePermissionSource implements PermissionSource {
  private readonly handlers = new Map<string, Handler>();

  onRequest(sessionId: string, handler: Handler): () => void {
    this.handlers.set(sessionId, handler);
    return () => {
      if (this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
    };
  }

  async ask(
    sessionId: string,
    payload: Record<string, unknown>,
    signal = new AbortController().signal,
  ): Promise<PermissionDecision> {
    const handler = this.handlers.get(sessionId);
    if (handler === undefined) return { behavior: "deny", message: "No run is listening" };
    return handler(payload, signal);
  }
}
