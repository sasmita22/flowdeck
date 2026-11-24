import { dirname } from "node:path";
import type { ManifestContainer } from "../../core/compiler/lower.js";
import type { LoadedBuild, StartedSessionsView } from "../../core/run/execute.js";
import {
  denied,
  permissionDecision,
  permissionRequest,
  type PermissionDecision,
} from "../../core/run/permission.js";
import {
  SessionWatch,
  type AskingNode,
  type SessionFailure,
  type SessionHookEvent,
} from "../../core/run/session-watch.js";
import { nodeStatus } from "../../core/run/run-events.js";
import { sessionState } from "../../core/run/session-state.js";
import type { EventEntry, RunSession, StoredEvent } from "../../core/run/store.js";
import type { TurnEvents } from "../../core/run/turns.js";
import type { HookEventKind } from "../../ports/event-source.js";
import type { FileSystem } from "../../ports/file-system.js";
import type { PermissionSource } from "../../ports/permission-source.js";
import type { Store } from "../../ports/store.js";
import type { Waiter } from "../../ports/waiter.js";

export const sessionPollMs = 2000;

const hookKinds: Record<HookEventKind, true> = {
  Stop: true,
  PreToolUse: true,
  PostToolUse: true,
  PostToolUseFailure: true,
  SubagentStop: true,
  StopFailure: true,
};

export type StartedSessionsOptions = {
  runId: string;
  events: TurnEvents;
  permissions?: PermissionSource;
  fs?: Pick<FileSystem, "readFile">;
  store: Pick<Store, "appendAll">;
  waiter: Waiter;
  sessionAlive: (tmuxName: string) => Promise<boolean>;
  endSession: (tmuxName: string) => Promise<void>;
  answerDialogs?: (tmuxName: string) => Promise<void>;
  writeStates: (text: string) => void;
  manifest: LoadedBuild;
  sessions: readonly RunSession[];
  history?: readonly StoredEvent[];
  onStart?: () => void;
};

type Watched = {
  session: RunSession;
  container: ManifestContainer;
  watch: SessionWatch;
  dialogsAnswered: boolean;
  gone: boolean;
  openAsks: Map<string, number>;
  subagents: Map<string, string>;
  events: EventEntry[];
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const entriesOf = (history: readonly StoredEvent[]): EventEntry[] =>
  history.map((event) => ({ nodeId: event.nodeId, event }));

const failedIn = (
  container: ManifestContainer,
  history: readonly StoredEvent[],
): SessionFailure | undefined => {
  const node = container.nodes.find(
    ({ id }) => nodeStatus(history.filter((event) => event.nodeId === id)) === "failed",
  );
  return node === undefined ? undefined : { container: container.name, node: node.label };
};

export class StartedSessions implements StartedSessionsView {
  private readonly watched: Watched[];
  private readonly unsubscribes: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private halted = false;
  private recordedFailure: SessionFailure | undefined;

  constructor(private readonly options: StartedSessionsOptions) {
    const containers = (options.manifest.containers ?? []).filter(
      (container) => container.kind === "session",
    );
    this.watched = options.sessions.flatMap((session) => {
      const container = containers.find(({ worktree }) => worktree === session.cwd);
      if (container === undefined) return [];
      const watch = new SessionWatch({ container, sessionId: session.claudeSessionId });
      watch.seed(options.history ?? []);
      const nodeIds = new Set(container.nodes.map(({ id }) => id));
      const events = entriesOf(options.history ?? []).filter(({ nodeId }) => nodeIds.has(nodeId));
      return [
        {
          session,
          container,
          watch,
          dialogsAnswered: false,
          gone: false,
          openAsks: new Map(),
          subagents: new Map(),
          events,
        },
      ];
    });
    this.recordedFailure = this.watched
      .map(({ container }) => failedIn(container, options.history ?? []))
      .find((failure) => failure !== undefined);
    this.writeStates();
    for (const watched of this.watched) this.listen(watched);
    this.timer = setInterval(() => void this.poll(), sessionPollMs);
  }

  started(): string[] {
    return this.watched
      .filter(({ watch }) => watch.started)
      .map(({ session }) => session.claudeSessionId);
  }

  failure(): SessionFailure | undefined {
    return this.recordedFailure;
  }

  failNode(claudeSessionId: string, nodeId: string, message: string): void {
    const watched = this.watched.find(({ session }) => session.claudeSessionId === claudeSessionId);
    if (watched === undefined) return;
    this.append(watched, watched.watch.failAt(nodeId, message));
  }

  halt(): void {
    this.halted = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async finish(): Promise<void> {
    this.halt();
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const { session } of this.watched) {
      if (await this.options.sessionAlive(session.tmuxName)) {
        await this.options.endSession(session.tmuxName);
      }
    }
  }

  private listen(watched: Watched): void {
    const { events, permissions } = this.options;
    const sessionId = watched.session.claudeSessionId;
    for (const kind of Object.keys(hookKinds) as HookEventKind[]) {
      this.unsubscribes.push(
        events.subscribe(kind, sessionId, (event) => this.accept(watched, { ...event, kind })),
      );
    }
    const unsubscribe = permissions?.onRequest(sessionId, (payload, signal) =>
      this.ask(watched, payload, signal),
    );
    if (unsubscribe !== undefined) this.unsubscribes.push(unsubscribe);
  }

  private accept(watched: Watched, event: SessionHookEvent): void {
    const wasStarted = watched.watch.started;
    this.append(watched, watched.watch.accept(event));
    if (!wasStarted && watched.watch.started) this.options.onStart?.();
  }

  private async ask(
    watched: Watched,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const { container, openAsks, watch } = watched;
    const resolved = await this.askingNode(watched, payload);
    const asking: AskingNode =
      "node" in resolved && watch.isOpen(resolved.node) && !signal.aborted
        ? resolved
        : { candidates: signal.aborted ? [] : watch.openCalls.map(({ nodeId }) => nodeId) };
    const candidates = "candidates" in asking ? asking.candidates : [];
    const open = "node" in asking ? asking.node : candidates[0];
    const nodeId =
      open ?? container.nodes.find((node) => node.type === "trigger")?.id ?? container.slug;
    if (open !== undefined) {
      const asks = openAsks.get(open) ?? 0;
      openAsks.set(open, asks + 1);
      const waitingForYou =
        nodeStatus(
          watched.events.filter(({ nodeId }) => nodeId === open).map(({ event }) => event),
        ) === "needs-you";
      if (asks === 0 && !waitingForYou) {
        this.append(watched, [{ nodeId: open, event: { kind: "needs-you" } }]);
      }
    }
    try {
      return permissionDecision(
        await this.options.waiter.wait(permissionRequest(nodeId, payload, candidates), signal),
      );
    } catch (error) {
      return denied(messageOf(error));
    } finally {
      if (open !== undefined) this.answered(watched, open);
    }
  }

  private async askingNode(
    watched: Watched,
    payload: Record<string, unknown>,
  ): Promise<AskingNode> {
    const { watch, subagents } = watched;
    const asking = watch.askingNode(payload);
    const agentId = payload["agent_id"];
    if ("node" in asking || typeof agentId !== "string") return asking;
    const known = subagents.get(agentId);
    if (known !== undefined && watch.isOpen(known)) return { node: known };
    const toolUseId = await this.parentCallOf(watched, payload, agentId);
    const node = watch.openCalls.find((call) => call.toolUseId === toolUseId)?.nodeId;
    if (toolUseId === undefined || node === undefined) return asking;
    subagents.set(agentId, node);
    return { node };
  }

  private async parentCallOf(
    watched: Watched,
    payload: Record<string, unknown>,
    agentId: string,
  ): Promise<string | undefined> {
    const transcript = payload["transcript_path"];
    const { fs } = this.options;
    if (fs === undefined || typeof transcript !== "string") return undefined;
    const sessionId = watched.session.claudeSessionId;
    const metaPath = `${dirname(transcript)}/${sessionId}/subagents/agent-${agentId}.meta.json`;
    try {
      const meta: unknown = JSON.parse(await fs.readFile(metaPath));
      const toolUseId =
        typeof meta === "object" && meta !== null
          ? (meta as Record<string, unknown>)["toolUseId"]
          : undefined;
      return typeof toolUseId === "string" ? toolUseId : undefined;
    } catch {
      return undefined;
    }
  }

  private answered(watched: Watched, nodeId: string): void {
    const asks = (watched.openAsks.get(nodeId) ?? 1) - 1;
    watched.openAsks.set(nodeId, asks);
    if (asks === 0 && watched.watch.isOpen(nodeId)) {
      this.append(watched, [{ nodeId, event: { kind: "running" } }]);
    }
  }

  private append(watched: Watched, entries: readonly EventEntry[]): void {
    if (this.halted || entries.length === 0) return;
    this.options.store.appendAll(this.options.runId, entries);
    watched.events.push(...entries);
    this.writeStates();
    const { container } = watched;
    const failed = entries.find(({ event }) => event.kind === "failed");
    if (failed === undefined || this.recordedFailure !== undefined) return;
    const node = container.nodes.find(({ id }) => id === failed.nodeId);
    this.recordedFailure = { container: container.name, node: node?.label ?? failed.nodeId };
  }

  private writeStates(): void {
    const lines = this.watched.map(({ session, container, events }) => {
      const nodeIds = container.nodes.map(({ id }) => id);
      const stopNode = container.nodes.find(({ type }) => type === "output")?.id;
      return `${session.tmuxName} ${sessionState({ nodeIds, stopNode }, events)}\n`;
    });
    this.options.writeStates(lines.join(""));
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const watched of this.watched) {
        if (this.timer === undefined) return;
        await this.check(watched);
      }
    } finally {
      this.polling = false;
    }
  }

  private async check(watched: Watched): Promise<void> {
    const { answerDialogs, sessionAlive } = this.options;
    const awaitingDialogs = answerDialogs !== undefined && !watched.dialogsAnswered;
    const watchingDeath = watched.watch.started && !watched.gone;
    if (!awaitingDialogs && !watchingDeath) return;
    const alive = await sessionAlive(watched.session.tmuxName);
    if (this.timer === undefined) return;
    if (alive && awaitingDialogs && answerDialogs !== undefined) {
      watched.dialogsAnswered = true;
      void answerDialogs(watched.session.tmuxName).catch((error: unknown) => {
        this.append(watched, watched.watch.fail(messageOf(error)));
      });
    }
    if (!alive && watchingDeath) {
      watched.gone = true;
      this.append(watched, watched.watch.died());
    }
  }
}
