import { describe, expect, it } from "vitest";
import {
  createBuildProgressStore,
  type BuildProgressBridge,
} from "../../../src/app/renderer/build-progress-store.js";
import {
  progressOf,
  type BuildEvent,
  type BuildOutcome,
  type PendingBuild,
  type StoredBuildEvent,
} from "../../../src/core/run/build-progress.js";

const pending = (
  id: string,
  flowId: string,
  version: number,
  outcome?: BuildOutcome,
): PendingBuild => ({
  id,
  flowId,
  version,
  name: `v${version}`,
  origin: null,
  startedAt: 1_000,
  ...(outcome === undefined ? {} : { outcome, endedAt: 9_000 }),
});

const stored = (events: BuildEvent[]): StoredBuildEvent[] =>
  events.map((event, index) => ({ ...event, seq: index + 1, at: 1_000 + index * 100 }));

const atStep = (step: 1 | 2 | 3 | 4 | 5): BuildEvent[] =>
  [1, 2, 3, 4, 5]
    .filter((n) => n <= step)
    .map((n) => ({
      type: "step",
      step: n as 1 | 2 | 3 | 4 | 5,
      status: n === step ? "running" : "done",
    }));

const entry = (build: PendingBuild, events: BuildEvent[] = atStep(1), buildId?: string) => ({
  pendingId: build.id,
  flowId: build.flowId,
  progress: progressOf(build, stored(events)),
  ...(buildId === undefined ? {} : { buildId }),
});

const subagent = (id: number, nodeId: string, state: "running" | "finished") => ({
  id,
  nodeId,
  at: 1_000 + id,
  summary: nodeId,
  kind: "subagent" as const,
  agentType: "flowdeck-build:piece-auditor",
  state,
});

const setup = async (
  listed: unknown,
  activity: unknown = [],
  rebuildAnswer: () => Promise<unknown> = () =>
    Promise.resolve({ kind: "started", pendingId: "pb-new" }),
) => {
  let push: (update: unknown) => void = () => undefined;
  let pushActivity: (update: unknown) => void = () => undefined;
  const asked: unknown[] = [];
  const calls: string[] = [];
  const stopped: unknown[] = [];
  const rebuilt: unknown[] = [];
  const bridge: BuildProgressBridge = {
    buildRebuild: (payload) => {
      rebuilt.push(payload);
      return rebuildAnswer();
    },
    listBuildProgress: () => {
      calls.push("list");
      return Promise.resolve(listed);
    },
    onBuildProgress: (listener) => {
      calls.push("subscribe");
      push = listener;
      return () => undefined;
    },
    stopBuild: (payload) => {
      stopped.push(payload);
      return Promise.resolve(undefined);
    },
    getBuildActivity: (payload) => {
      asked.push(payload);
      return Promise.resolve(activity);
    },
    onBuildActivity: (listener) => {
      pushActivity = listener;
      return () => undefined;
    },
  };
  const store = createBuildProgressStore(bridge);
  await store.getState().connect();
  return {
    store,
    calls,
    stopped,
    rebuilt,
    asked,
    push: (update: unknown) => push(update),
    pushActivity: (update: unknown) => pushActivity(update),
  };
};

describe("build progress store", () => {
  it("loads the listed builds on connect", async () => {
    const { store, calls } = await setup([entry(pending("pb-1", "flow-a", 1), atStep(2))]);

    expect(calls).toContain("list");
    expect(store.getState().chipFor("flow-a")).toBe("Building · step 2 of 5");
    expect(store.getState().progressFor("pb-1")?.chip).toBe("Building · step 2 of 5");
  });

  it("applies a push after the list loaded", async () => {
    const build = pending("pb-1", "flow-a", 1);
    const { store, push } = await setup([entry(build, atStep(1))]);

    push(entry(build, atStep(3)));

    expect(store.getState().chipFor("flow-a")).toBe("Building · step 3 of 5");
    expect(store.getState().progressFor("pb-1")?.steps[2]?.status).toBe("running");
  });

  it("picks up a build first seen through a push", async () => {
    const { store, push } = await setup([]);

    push(entry(pending("pb-9", "flow-b", 2), atStep(4)));

    expect(store.getState().chipFor("flow-b")).toBe("Building · step 4 of 5");
    expect(store.getState().isBuilding("flow-b")).toBe(true);
  });

  it("shows the final chip once the build ends", async () => {
    const { store, push } = await setup([entry(pending("pb-1", "flow-a", 4), atStep(5))]);

    push(entry(pending("pb-1", "flow-a", 4, "built"), atStep(5), "b-1"));

    expect(store.getState().chipFor("flow-a")).toBe("Built · v4");
    expect(store.getState().isBuilding("flow-a")).toBe(false);
  });

  it("knows nothing of a blueprint that was never built", async () => {
    const { store } = await setup([entry(pending("pb-1", "flow-a", 1))]);

    expect(store.getState().chipFor("flow-z")).toBeUndefined();
    expect(store.getState().barFor("flow-z")).toBeUndefined();
    expect(store.getState().progressFor("pb-404")).toBeUndefined();
    expect(store.getState().isBuilding("flow-z")).toBe(false);
  });

  it("has a bar while the build is open", async () => {
    const { store } = await setup([entry(pending("pb-1", "flow-a", 1), atStep(2))]);

    expect(store.getState().barFor("flow-a")).toBeDefined();
    expect(store.getState().isBuilding("flow-a")).toBe(true);
  });

  it.each<BuildOutcome>(["built", "needs-you", "failed", "stopped"])(
    "keeps the bar after a build ends %s",
    async (outcome) => {
      const { store } = await setup([entry(pending("pb-1", "flow-a", 1, outcome), atStep(3))]);

      expect(store.getState().barFor("flow-a")).toBeDefined();
      expect(store.getState().isBuilding("flow-a")).toBe(false);
    },
  );

  it("prefers the open build over an earlier finished one of the same blueprint", async () => {
    const { store } = await setup([
      entry(pending("pb-2", "flow-a", 2), atStep(2)),
      entry(pending("pb-1", "flow-a", 1, "built"), atStep(5), "b-1"),
    ]);

    expect(store.getState().chipFor("flow-a")).toBe("Building · step 2 of 5");
    expect(store.getState().isBuilding("flow-a")).toBe(true);
    expect(store.getState().progressFor("pb-1")?.chip).toBe("Built · v1");
  });

  it("reads a node's audit status from the build's components", async () => {
    const build = pending("pb-1", "flow-a", 1);
    const { store, push } = await setup([]);

    push(
      entry(build, [
        ...atStep(3),
        { type: "component", path: "agents/a.md", kind: "agent", nodeIds: ["n1"], status: "done" },
        {
          type: "component",
          path: "agents/b.md",
          kind: "agent",
          nodeIds: ["n2", "n3"],
          status: "running",
        },
      ]),
    );

    expect(store.getState().nodeAuditStatus("flow-a", "n1")).toBe("done");
    expect(store.getState().nodeAuditStatus("flow-a", "n3")).toBe("running");
    expect(store.getState().nodeAuditStatus("flow-a", "n9")).toBeUndefined();
    expect(store.getState().nodeAuditStatus("flow-z", "n1")).toBeUndefined();
  });

  it("keeps the questions a build ended with", async () => {
    const questions = [{ nodeId: "n1", text: "Who writes notes.md?", otherNodeId: "n0" }];
    const ended = entry(pending("pb-1", "flow-a", 1, "needs-you"), atStep(3));
    const { store } = await setup([{ ...ended, progress: { ...ended.progress, questions } }]);

    expect(store.getState().progressFor("pb-1")?.questions).toEqual(questions);
  });

  it("loads a build's activity, then takes pushed entries for that build, newest version of each", async () => {
    const { store, asked, pushActivity } = await setup(
      [entry(pending("pb-1", "flow-a", 1), atStep(3))],
      [subagent(1, "agents/c.md", "running")],
    );

    await store.getState().viewActivity("pb-1");
    pushActivity({ pendingId: "pb-1", entry: subagent(1, "agents/c.md", "finished") });
    pushActivity({ pendingId: "pb-1", entry: subagent(2, "agents/a.md", "running") });
    pushActivity({ pendingId: "pb-2", entry: subagent(3, "agents/b.md", "running") });

    expect(asked).toEqual([{ pendingId: "pb-1" }]);
    expect(store.getState().activityFor("pb-1")).toEqual([
      subagent(1, "agents/c.md", "finished"),
      subagent(2, "agents/a.md", "running"),
    ]);
  });

  it("stops a build through the bridge", async () => {
    const { store, stopped } = await setup([entry(pending("pb-1", "flow-a", 1), atStep(2))]);

    expect(store.getState().stop).toEqual(expect.any(Function));
    await store.getState().stop("pb-1");

    expect(stopped).toEqual([{ pendingId: "pb-1" }]);
  });

  describe("answering a build's questions", () => {
    const questions = [
      { nodeId: "n1", text: "Who writes notes.md?", otherNodeId: "n0" },
      { nodeId: "n2", text: "Which command runs the tests?" },
    ];

    const asking = (pendingId = "pb-1") => {
      const ended = entry(pending(pendingId, "flow-a", 1, "needs-you"), atStep(3));
      return { ...ended, progress: { ...ended.progress, questions } };
    };

    const deferred = () => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };

    it("keeps one draft per question of each build", async () => {
      const { store } = await setup([asking("pb-1"), asking("pb-2")]);

      store.getState().setAnswer("pb-1", 0, "n");
      store.getState().setAnswer("pb-1", 0, "n1 writes it");
      store.getState().setAnswer("pb-1", 1, "npm test");

      expect(store.getState().answerFor("pb-1", 0)).toBe("n1 writes it");
      expect(store.getState().answerFor("pb-1", 1)).toBe("npm test");
      expect(store.getState().answerFor("pb-2", 0)).toBe("");
    });

    it("rebuilds with each question and its answer once every question is answered", async () => {
      const { store, rebuilt } = await setup([asking()]);

      store.getState().setAnswer("pb-1", 0, "n1 writes it");
      store.getState().setAnswer("pb-1", 1, "npm test");
      expect(store.getState().canRebuild("pb-1")).toBe(true);
      await store.getState().rebuild("pb-1");

      expect(rebuilt).toEqual([
        {
          pendingId: "pb-1",
          answers: [
            {
              nodeId: "n1",
              text: "Who writes notes.md?",
              otherNodeId: "n0",
              answer: "n1 writes it",
            },
            { nodeId: "n2", text: "Which command runs the tests?", answer: "npm test" },
          ],
        },
      ]);
    });

    it.each([
      ["no answers", [] as [number, string][]],
      ["one question unanswered", [[0, "n1 writes it"]] as [number, string][]],
      [
        "a blank answer",
        [
          [0, "n1 writes it"],
          [1, "   "],
        ] as [number, string][],
      ],
    ])("sends nothing with %s", async (_, drafts) => {
      const { store, rebuilt } = await setup([asking()]);

      drafts.forEach(([index, text]) => store.getState().setAnswer("pb-1", index, text));
      expect(store.getState().canRebuild("pb-1")).toBe(false);
      await store.getState().rebuild("pb-1");

      expect(rebuilt).toEqual([]);
    });

    it("sends nothing for a build with no questions", async () => {
      const { store, rebuilt } = await setup([
        entry(pending("pb-1", "flow-a", 1, "failed"), atStep(3)),
      ]);

      expect(store.getState().canRebuild("pb-1")).toBe(false);
      await store.getState().rebuild("pb-1");

      expect(rebuilt).toEqual([]);
    });

    it("sends one rebuild while one is in flight", async () => {
      const answer = deferred();
      const { store, rebuilt } = await setup([asking()], [], () => answer.promise);
      store.getState().setAnswer("pb-1", 0, "n1 writes it");
      store.getState().setAnswer("pb-1", 1, "npm test");

      const first = store.getState().rebuild("pb-1");
      expect(store.getState().isRebuilding("pb-1")).toBe(true);
      expect(store.getState().canRebuild("pb-1")).toBe(false);
      await store.getState().rebuild("pb-1");
      answer.resolve({ kind: "started", pendingId: "pb-new" });
      await first;

      expect(rebuilt).toHaveLength(1);
      expect(store.getState().isRebuilding("pb-1")).toBe(false);
    });

    it("clears the drafts once the rebuild started", async () => {
      const { store } = await setup([asking()]);
      store.getState().setAnswer("pb-1", 0, "n1 writes it");
      store.getState().setAnswer("pb-1", 1, "npm test");

      await store.getState().rebuild("pb-1");

      expect(store.getState().answerFor("pb-1", 0)).toBe("");
      expect(store.getState().answerFor("pb-1", 1)).toBe("");
      expect(store.getState().rebuildErrorFor("pb-1")).toBeUndefined();
    });

    it.each([
      [
        "the engine refuses it",
        () => Promise.reject(new Error("Build fix-a did not keep its inputs")),
        "Build fix-a did not keep its inputs",
      ],
      [
        "the build cannot start",
        () => Promise.resolve({ kind: "error", message: "fix-a is already building" }),
        "fix-a is already building",
      ],
    ])("keeps the drafts and shows the reason when %s", async (_, answer, message) => {
      const { store } = await setup([asking()], [], answer);
      store.getState().setAnswer("pb-1", 0, "n1 writes it");
      store.getState().setAnswer("pb-1", 1, "npm test");

      await store.getState().rebuild("pb-1");

      expect(store.getState().rebuildErrorFor("pb-1")).toBe(message);
      expect(store.getState().answerFor("pb-1", 0)).toBe("n1 writes it");
      expect(store.getState().answerFor("pb-1", 1)).toBe("npm test");
      expect(store.getState().isRebuilding("pb-1")).toBe(false);
    });
  });

  it("gives every node of a merged component that component's status", async () => {
    const { store } = await setup([
      entry(pending("pb-1", "flow-a", 1), [
        ...atStep(3),
        {
          type: "component",
          path: "agents/merged.md",
          kind: "agent",
          nodeIds: ["n4", "n5"],
          status: "failed",
        },
      ]),
    ]);

    expect(store.getState().nodeAuditStatus("flow-a", "n4")).toBe("failed");
    expect(store.getState().nodeAuditStatus("flow-a", "n5")).toBe("failed");
  });

  it("ignores a push or a list it cannot read", async () => {
    const { store, push } = await setup({ nope: true });

    push({ pendingId: "pb-1" });

    expect(store.getState().chipFor("flow-a")).toBeUndefined();
    push(entry(pending("pb-1", "flow-a", 1), atStep(2)));
    expect(store.getState().chipFor("flow-a")).toBe("Building · step 2 of 5");
  });
});
