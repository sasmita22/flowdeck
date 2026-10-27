export class EventBus<E extends { kind: string; sessionId: string }> {
  private readonly handlers = new Map<string, Set<(event: E) => void>>();

  publish(event: E): void {
    for (const handler of this.handlers.get(key(event.kind, event.sessionId)) ?? []) {
      handler(event);
    }
  }

  subscribe(kind: E["kind"], sessionId: string, handler: (event: E) => void): () => void {
    const registration = (event: E) => handler(event);
    const slot = key(kind, sessionId);
    const handlers = this.handlers.get(slot) ?? new Set();
    handlers.add(registration);
    this.handlers.set(slot, handlers);
    return () => {
      handlers.delete(registration);
      if (handlers.size === 0 && this.handlers.get(slot) === handlers) this.handlers.delete(slot);
    };
  }
}

function key(kind: string, sessionId: string): string {
  return JSON.stringify([kind, sessionId]);
}
