import { EventBus } from "../../src/core/event-bus.js";
import type { EventSource, HookEvent, HookEventKind } from "../../src/ports/event-source.js";

export class FakeEventSource implements EventSource {
  private readonly bus = new EventBus<HookEvent>();

  publish(event: HookEvent): void {
    this.bus.publish(event);
  }

  subscribe(
    kind: HookEventKind,
    sessionId: string,
    handler: (event: HookEvent) => void,
  ): () => void {
    return this.bus.subscribe(kind, sessionId, handler);
  }
}
