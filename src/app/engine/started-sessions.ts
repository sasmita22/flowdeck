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
  type SessionFailure,
  type SessionHookEvent,
} from "../../core/run/session-watch.js";
import { nodeStatus } from "../../core/run/run-events.js";
import type { EventEntry, RunSession, StoredEvent } from "../../core/run/store.js";
import type { TurnEvents } from "../../core/run/turns.js";
import type { HookEventKind } from "../../ports/event-source.js";
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
  store: Pick<Store, "appendAll">;
  waiter: Waiter;
  sessionAlive: (tmuxName: string) => Promise<boolean>;
  endSession: (tmuxName: string) => Promise<void>;
  answerDialogs?: (tmuxName: string) => Promise<void>;
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
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
      return [
        { session, container, watch, dialogsAnswered: false, gone: false, openAsks: new Map() },
      ];
    });
    this.recordedFailure = this.watched
      .map(({ container }) => failedIn(container, options.history ?? []))
      .find((failure) => failure !== undefined);
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
    const { container, watch, openAsks } = watched;
    const open = watch.openNode;
    const nodeId =
      open ?? container.nodes.find((node) => node.type === "trigger")?.id ?? container.slug;
    if (open !== undefined) {
      const asks = openAsks.get(open) ?? 0;
      openAsks.set(open, asks + 1);
      if (asks === 0) this.append(watched, [{ nodeId: open, event: { kind: "needs-you" } }]);
    }
    try {
      return permissionDecision(
        await this.options.waiter.wait(permissionRequest(nodeId, payload), signal),
      );
    } catch (error) {
      return denied(messageOf(error));
    } finally {
      if (open !== undefined) this.answered(watched, open);
    }
  }

  private answered(watched: Watched, nodeId: string): void {
    const asks = (watched.openAsks.get(nodeId) ?? 1) - 1;
    watched.openAsks.set(nodeId, asks);
    if (asks === 0 && watched.watch.openNode === nodeId) {
      this.append(watched, [{ nodeId, event: { kind: "running" } }]);
    }
  }

  private append({ container }: Watched, entries: readonly EventEntry[]): void {
    if (this.halted || entries.length === 0) return;
    this.options.store.appendAll(this.options.runId, entries);
    const failed = entries.find(({ event }) => event.kind === "failed");
    if (failed === undefined || this.recordedFailure !== undefined) return;
    const node = container.nodes.find(({ id }) => id === failed.nodeId);
    this.recordedFailure = { container: container.name, node: node?.label ?? failed.nodeId };
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
