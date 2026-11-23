import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepoGate, repoGateDeadlineMs } from "../../../src/app/engine/repo-gate.js";
import type { RepoState } from "../../../src/core/run/repo-state.js";
import type { RunSessionRecord } from "../../../src/core/run/store.js";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const state = (head: string): RepoState => ({
  kind: "read",
  branch: "main",
  head,
  upstream: null,
  staged: 0,
  unstaged: 0,
  untracked: 0,
});

const ownTops = { "/w/run": "/w/run", "/src/app": "/src" };

type Answers<T> = Record<string, T | (() => Promise<T>)>;

const answer = <T>(answers: Answers<T>, key: string): Promise<T> => {
  if (!(key in answers)) return never();
  const value = answers[key] as T | (() => Promise<T>);
  return typeof value === "function" ? (value as () => Promise<T>)() : Promise.resolve(value);
};

const gateWith = ({
  tops = {},
  states = {},
  seen = [],
  record,
}: {
  tops?: Answers<string | null>;
  states?: Answers<RepoState>;
  seen?: string[];
  record?: (repo: string, state: RepoState) => void;
} = {}) => {
  const calls: string[] = [];
  const recorded: [string, RepoState][] = [];
  const logs: string[] = [];
  const repoGate = createRepoGate({
    own: ["/w/run", "/src/app"],
    seen,
    home: "/u",
    gitState: {
      topLevel: (path) => {
        calls.push(`topLevel ${path}`);
        return answer(tops, path);
      },
    },
    readState: (repo) => {
      calls.push(`read ${repo}`);
      return answer(states, repo);
    },
    record:
      record ??
      ((repo, read) => {
        recorded.push([repo, read]);
      }),
    log: (line) => logs.push(line),
  });
  return { gate: repoGate.check, close: repoGate.close, calls, recorded, logs };
};

const settledNow = async (pending: Promise<void>): Promise<boolean> => {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
};

const tracked = (pending: Promise<void>) => {
  const flag = { settled: false };
  void pending.then(() => {
    flag.settled = true;
  });
  return flag;
};

const touching = (input: object) => ({ tool_name: "Bash", tool_input: input });

describe("createRepoGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["no path", { pattern: "foo" }],
    ["no tool input", undefined],
    ["a relative path", { file_path: "src/a.ts" }],
    ["a file in the run's folder", { file_path: "/w/run/src/a.ts" }],
    ["the run's folder itself", { command: "cd /w/run && git status" }],
    ["a file in the run's repo", { file_path: "/src/app/lib/b.ts" }],
    ["a file in a repo stored as seen", { file_path: "/seen/repo/c.ts" }],
    ["a ~/ path in a repo stored as seen", { command: "git -C ~/web pull" }],
  ])("answers %s at once with no git call", async (_name, input) => {
    const { gate, calls, recorded } = gateWith({ seen: ["/seen/repo", "/u/web"] });

    expect(await settledNow(gate(input === undefined ? {} : touching(input)))).toBe(true);
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("answers a call in a repo recorded earlier at once with no git call", async () => {
    const { gate, calls, recorded } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b" },
      states: { "/b": state("b1") },
    });
    await gate(touching({ file_path: "/b/x.ts" }));
    calls.length = 0;

    expect(await settledNow(gate(touching({ file_path: "/b/deep/y.ts" })))).toBe(true);
    expect(calls).toEqual([]);
    expect(recorded).toHaveLength(1);
  });

  it("reads and records a repo's state on its first touch, then never again", async () => {
    const { gate, calls, recorded } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b", "/b/z.ts": "/b" },
      states: { "/b": state("b1") },
    });

    await gate(touching({ file_path: "/b/x.ts" }));

    expect(calls.filter((call) => call.startsWith("read"))).toEqual(["read /b"]);
    expect(calls.filter((call) => call.includes("/b/"))).toEqual(["topLevel /b/x.ts"]);
    expect(recorded).toEqual([["/b", state("b1")]]);

    await Promise.all([
      gate(touching({ file_path: "/b/z.ts" })),
      gate(touching({ command: "cd /b && git commit -m x" })),
    ]);

    expect(calls.filter((call) => call.startsWith("read"))).toEqual(["read /b"]);
    expect(recorded).toEqual([["/b", state("b1")]]);
  });

  it("records a repo once when two calls touch it for the first time together", async () => {
    let release: (read: RepoState) => void = () => undefined;
    const { gate, calls, recorded } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b", "/b/z.ts": "/b" },
      states: { "/b": () => new Promise<RepoState>((resolve) => (release = resolve)) },
    });

    const first = gate(touching({ file_path: "/b/x.ts" }));
    const second = gate(touching({ file_path: "/b/z.ts" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(state("b1"));
    await Promise.all([first, second]);

    expect(calls.filter((call) => call.startsWith("read"))).toEqual(["read /b"]);
    expect(recorded).toEqual([["/b", state("b1")]]);
  });

  it("skips a path whose top level is the top level of one of the run's folders", async () => {
    const { gate, calls, recorded } = gateWith({
      tops: { ...ownTops, "/src/lib/a.ts": "/src" },
    });

    await gate(touching({ file_path: "/src/lib/a.ts" }));

    expect(calls.filter((call) => call.startsWith("read"))).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("skips a path that is in no repo", async () => {
    const { gate, calls, recorded } = gateWith({ tops: { ...ownTops, "/tmp/a.txt": null } });

    await gate(touching({ file_path: "/tmp/a.txt" }));

    expect(calls.filter((call) => call.startsWith("read"))).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("records not recorded when the read misses the deadline, and drops the late result", async () => {
    vi.useFakeTimers();
    let release: (read: RepoState) => void = () => undefined;
    const { gate, recorded } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b" },
      states: { "/b": () => new Promise<RepoState>((resolve) => (release = resolve)) },
    });

    const call = tracked(gate(touching({ file_path: "/b/x.ts" })));
    await vi.advanceTimersByTimeAsync(repoGateDeadlineMs - 1);

    expect(call.settled).toBe(false);
    expect(recorded).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    expect(recorded).toEqual([["/b", { kind: "unreadable" }]]);

    release(state("late"));
    await vi.advanceTimersByTimeAsync(0);

    expect(recorded).toEqual([["/b", { kind: "unreadable" }]]);
  });

  it("records nothing when the read settles after the gate closes, and still answers", async () => {
    let release: (read: RepoState) => void = () => undefined;
    const { gate, close, recorded, logs } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b" },
      states: { "/b": () => new Promise<RepoState>((resolve) => (release = resolve)) },
    });

    const call = gate(touching({ file_path: "/b/x.ts" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    close();
    release(state("b1"));

    await expect(call).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("answers at the deadline when the top level lookup does not settle", async () => {
    vi.useFakeTimers();
    const { gate, recorded } = gateWith({ tops: ownTops });

    const call = tracked(gate(touching({ file_path: "/b/x.ts" })));
    await vi.advanceTimersByTimeAsync(repoGateDeadlineMs);

    expect(call.settled).toBe(true);
    expect(recorded).toEqual([]);
  });

  it("logs a failed top level lookup and answers", async () => {
    const { gate, recorded, logs } = gateWith({
      tops: { ...ownTops, "/b/x.ts": () => Promise.reject(new Error("git is gone")) },
    });

    await expect(gate(touching({ file_path: "/b/x.ts" }))).resolves.toBeUndefined();

    expect(recorded).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("git is gone")]);
  });

  it("logs a failed record and answers", async () => {
    const { gate, logs } = gateWith({
      tops: { ...ownTops, "/b/x.ts": "/b" },
      states: { "/b": state("b1") },
      record: () => {
        throw new Error("store closed");
      },
    });

    await expect(gate(touching({ file_path: "/b/x.ts" }))).resolves.toBeUndefined();

    expect(logs).toEqual([expect.stringContaining("store closed")]);
  });
});

describe("createRepoGate in a run with session containers", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000000";
  const androidId = "11111111-1111-4111-8111-111111111111";
  const workspace = "/b/workspace";
  const android = "/b/sessions/android/app";

  const sessions: RunSessionRecord[] = [
    { tmuxName: "fd-run-00000000", cwd: workspace, claudeSessionId: workspaceId, parent: null },
    { tmuxName: "fd-run-aaaaaaaa", cwd: android, claudeSessionId: androidId, parent: workspaceId },
  ];

  const tops: Answers<string | null> = {
    [workspace]: null,
    [android]: android,
    "/src/app": "/src",
    [`${android}/src/a.ts`]: android,
    "/b2/x.ts": "/b2",
  };

  const sessionGate = () => {
    const calls: string[] = [];
    const recorded: [string, RepoState][] = [];
    const repoGate = createRepoGate({
      own: ["/src/app"],
      sessions,
      seen: [],
      home: "/u",
      gitState: {
        topLevel: (path) => {
          calls.push(`topLevel ${path}`);
          return answer(tops, path);
        },
      },
      readState: (repo) => {
        calls.push(`read ${repo}`);
        return Promise.resolve(state(repo));
      },
      record: (repo, read) => {
        recorded.push([repo, read]);
      },
      log: () => undefined,
    });
    return { gate: repoGate.check, calls, recorded };
  };

  const from = (sessionId: string, input: object) => ({
    session_id: sessionId,
    ...touching(input),
  });

  it("answers a call in the calling session's own worktree at once with no git call", async () => {
    const { gate, calls, recorded } = sessionGate();

    expect(await settledNow(gate(from(androidId, { file_path: `${android}/src/a.ts` })))).toBe(
      true,
    );
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("skips another repo's path by the calling session's worktree, not the workspace folder", async () => {
    const { gate, calls, recorded } = sessionGate();

    await gate(from(androidId, { file_path: "/b2/x.ts" }));

    expect(calls).toContain(`topLevel ${android}`);
    expect(calls).not.toContain(`topLevel ${workspace}`);
    expect(recorded).toEqual([["/b2", state("/b2")]]);
  });

  it("never treats the workspace folder as a repo for the workspace session's calls", async () => {
    const { gate, calls, recorded } = sessionGate();

    await gate(from(workspaceId, { file_path: "/b2/x.ts" }));

    expect(calls).not.toContain(`topLevel ${workspace}`);
    expect(recorded).toEqual([["/b2", state("/b2")]]);
  });
});
