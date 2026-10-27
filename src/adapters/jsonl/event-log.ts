import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventSource, HookEvent, HookEventKind } from "../../ports/event-source.js";

export type EventLogOptions = {
  events: EventSource;
  path: string;
  runId: string;
  now?: () => Date;
};

const kinds: HookEventKind[] = ["Stop", "PreToolUse", "PostToolUse", "SubagentStop"];

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class EventLog {
  private readonly events: EventSource;
  private readonly path: string;
  private readonly runId: string;
  private readonly now: () => Date;
  private folderReady = false;

  constructor(options: EventLogOptions) {
    this.events = options.events;
    this.path = options.path;
    this.runId = options.runId;
    this.now = options.now ?? (() => new Date());
  }

  watch(sessionId: string): () => void {
    const unsubscribes = kinds.map((kind) =>
      this.events.subscribe(kind, sessionId, (event) => this.append(event)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  private append(event: HookEvent): void {
    const isToolEvent = event.kind === "PreToolUse" || event.kind === "PostToolUse";
    const isSubagentStop = event.kind === "SubagentStop";
    const line = {
      run_id: this.runId,
      session_id: event.sessionId,
      kind: event.kind,
      tool_name: isToolEvent ? stringOrNull(event.payload["tool_name"]) : null,
      agent_type: isSubagentStop ? stringOrNull(event.payload["agent_type"]) : null,
      agent_id: isSubagentStop ? stringOrNull(event.payload["agent_id"]) : null,
      time: this.now().toISOString(),
    };
    if (!this.folderReady) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.folderReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
  }
}
