import { isInside } from "../../core/run/delete-build.js";
import { toolInputPaths } from "../../core/run/other-repos.js";
import type { RepoState } from "../../core/run/repo-state.js";
import type { RunSessionRecord } from "../../core/run/store.js";
import type { GitState } from "../../ports/git-state.js";

export const repoGateDeadlineMs = 3000;

export type RepoGateOptions = {
  own: readonly string[];
  sessions?: readonly RunSessionRecord[];
  seen: readonly string[];
  home?: string;
  gitState: Pick<GitState, "topLevel">;
  readState: (repo: string) => Promise<RepoState>;
  record: (repo: string, state: RepoState) => void;
  log: (line: string) => void;
  deadlineMs?: number;
};

export type RepoGate = {
  check: (payload: Record<string, unknown>) => Promise<void>;
  close: () => void;
};

const late = Symbol("late");
type Deadline = { passed: Promise<typeof late>; cancel(): void };

const deadlineIn = (ms: number): Deadline => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  return { passed, cancel: () => clearTimeout(timer) };
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createRepoGate({
  own: runOwn,
  sessions = [],
  seen: stored,
  home,
  gitState,
  readState,
  record,
  log,
  deadlineMs = repoGateDeadlineMs,
}: RepoGateOptions): RepoGate {
  const seen = new Set(stored);
  const tops = new Map<string, Promise<string | null>>();
  const ownTops = new Map<string, Promise<Set<string>>>();
  let closed = false;

  const ownOf = (sessionId: string) => {
    const worktree = sessions.find(
      (session) => session.claudeSessionId === sessionId && session.parent !== null,
    )?.cwd;
    return worktree === undefined ? runOwn : [...runOwn, worktree];
  };

  const known = (own: readonly string[], path: string) =>
    [...own, ...seen].some((root) => path === root || isInside(root, path));

  const topLevelOf = (path: string) => {
    const cached = tops.get(path) ?? gitState.topLevel(path);
    tops.set(path, cached);
    cached.catch(() => tops.delete(path));
    return cached;
  };

  const ownTopsOf = (sessionId: string, own: readonly string[]) => {
    const cached =
      ownTops.get(sessionId) ??
      Promise.all(own.map(async (path) => (await topLevelOf(path).catch(() => null)) ?? path)).then(
        (found) => new Set([...own, ...found]),
      );
    ownTops.set(sessionId, cached);
    return cached;
  };

  const consider = async (
    sessionId: string,
    own: readonly string[],
    path: string,
    deadline: Deadline,
  ) => {
    if (known(own, path)) return;
    const top = await Promise.race([topLevelOf(path), deadline.passed]);
    if (top === late || top === null || seen.has(top)) return;
    const skipped = await Promise.race([ownTopsOf(sessionId, own), deadline.passed]);
    if (skipped === late || skipped.has(top) || seen.has(top)) return;
    seen.add(top);
    const state = await Promise.race([readState(top), deadline.passed]);
    if (closed) return;
    record(top, state === late ? { kind: "unreadable" } : state);
  };

  const check = async (payload: Record<string, unknown>) => {
    const caller = payload["session_id"];
    const sessionId = typeof caller === "string" ? caller : "";
    const own = ownOf(sessionId);
    const paths = toolInputPaths(
      JSON.stringify(payload["tool_input"] ?? null),
      home === undefined ? {} : { home },
    ).filter((path) => !known(own, path));
    if (paths.length === 0) return;
    const deadline = deadlineIn(deadlineMs);
    try {
      for (const path of paths) await consider(sessionId, own, path, deadline);
    } catch (error) {
      log(`other repo not recorded (${messageOf(error)})`);
    } finally {
      deadline.cancel();
    }
  };

  return {
    check,
    close: () => {
      closed = true;
    },
  };
}
