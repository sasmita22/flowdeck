import { describe, expect, it } from "vitest";
import {
  createBuildProgressStore,
  selectBuildingCards,
  selectBuildingCount,
  selectFlowBuilding,
  selectPipeline,
  type BuildProgressBridge,
} from "../../../src/app/renderer/build-progress-store.js";
import { buildPipelineOf } from "../../../src/core/run/build-pipeline.js";
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
  startedAt = 1_000,
): PendingBuild => ({
  id,
  flowId,
  version,
  name: `v${version}`,
  origin: null,
  startedAt,
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
  name: build.name,
  startedAt: build.startedAt,
  ...(build.endedAt === undefined ? {} : { endedAt: build.endedAt }),
  ...(build.outcome === undefined ? {} : { outcome: build.outcome }),
  events: stored(events),
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
    expect(store.getState().progressFor("pb-1")?.chip).toBe("Building · step 2 of 5");
  });

  it("applies a push after the list loaded", async () => {
    const build = pending("pb-1", "flow-a", 1);
    const { store, push } = await setup([entry(build, atStep(1))]);

    push(entry(build, atStep(3)));

    expect(store.getState().progressFor("pb-1")?.chip).toBe("Building · step 3 of 5");
    expect(store.getState().progressFor("pb-1")?.steps[2]?.status).toBe("running");
  });

  it("picks up a build first seen through a push", async () => {
    const { store, push } = await setup([]);

    push(entry(pending("pb-9", "flow-b", 2), atStep(4)));

    expect(store.getState().progressFor("pb-9")?.chip).toBe("Building · step 4 of 5");
  });

  it("shows the final chip once the build ends", async () => {
    const { store, push } = await setup([entry(pending("pb-1", "flow-a", 4), atStep(5))]);

    push(entry(pending("pb-1", "flow-a", 4, "built"), atStep(5), "b-1"));

    expect(store.getState().progressFor("pb-1")?.chip).toBe("Built · v4");
  });

  it("knows nothing of a build it was never told of", async () => {
    const { store } = await setup([entry(pending("pb-1", "flow-a", 1))]);

    expect(store.getState().progressFor("pb-404")).toBeUndefined();
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

  describe("building cards", () => {
    it("gives one card per build not yet built, newest start first", async () => {
      const { store } = await setup([
        entry(pending("pb-old", "flow-a", 1, "failed", 1_000), atStep(3)),
        entry(pending("pb-new", "flow-a", 1, undefined, 3_000), atStep(2)),
        entry(pending("pb-mid", "flow-b", 2, "needs-you", 2_000), atStep(3)),
        entry(pending("pb-done", "flow-c", 3, "built", 4_000), atStep(5), "b-1"),
      ]);

      const cards = selectBuildingCards(store.getState());

      expect(cards.map((card) => [card.pendingId, card.badge, card.live])).toEqual([
        ["pb-new", "Building · step 2 of 5", true],
        ["pb-mid", "Needs you", false],
        ["pb-old", "Failed", false],
      ]);
      expect(cards[0]).toMatchObject({ buildName: "v1", startedAt: 3_000 });
    });

    it("counts only the builds still open", async () => {
      const { store } = await setup([
        entry(pending("pb-1", "flow-a", 1), atStep(2)),
        entry(pending("pb-2", "flow-a", 1), atStep(4)),
        entry(pending("pb-3", "flow-a", 1, "needs-you"), atStep(3)),
        entry(pending("pb-4", "flow-a", 1, "failed"), atStep(3)),
        entry(pending("pb-5", "flow-a", 1, "stopped"), atStep(3)),
        entry(pending("pb-6", "flow-a", 1, "built"), atStep(5), "b-6"),
      ]);

      expect(selectBuildingCount(store.getState())).toBe(2);
    });

    it("drops a build from the cards and the count once it is built", async () => {
      const { store, push } = await setup([
        entry(pending("pb-1", "flow-a", 1), atStep(5)),
        entry(pending("pb-2", "flow-a", 1), atStep(2)),
      ]);
      expect(selectBuildingCount(store.getState())).toBe(2);

      push(entry(pending("pb-1", "flow-a", 1, "built"), atStep(5), "b-1"));

      expect(selectBuildingCards(store.getState()).map((card) => card.pendingId)).toEqual(["pb-2"]);
      expect(selectBuildingCount(store.getState())).toBe(1);
    });

    it("drops a needs-you card once a later build of the same name is built", async () => {
      const { store, push } = await setup([
        entry({ ...pending("pb-a", "flow-a", 1, "needs-you"), endedAt: 2_000 }, atStep(3)),
      ]);

      push(entry({ ...pending("pb-b", "flow-a", 1, "built"), endedAt: 3_000 }, atStep(5), "b-1"));

      expect(selectBuildingCards(store.getState())).toEqual([]);
    });

    it("shows only the newer of two failed builds of one name, and every open build", async () => {
      const { store, push } = await setup([
        entry({ ...pending("pb-older", "flow-a", 1, "failed", 1_000), endedAt: 2_000 }, atStep(3)),
        entry(pending("pb-open-1", "flow-a", 1, undefined, 4_000), atStep(2)),
        entry(pending("pb-open-2", "flow-a", 1, undefined, 5_000), atStep(1)),
      ]);

      push(
        entry({ ...pending("pb-newer", "flow-a", 1, "failed", 1_500), endedAt: 3_000 }, atStep(3)),
      );

      expect(selectBuildingCards(store.getState()).map((card) => card.pendingId)).toEqual([
        "pb-open-2",
        "pb-open-1",
        "pb-newer",
      ]);
    });

    it("drops a removed build's card and count", async () => {
      const { store } = await setup([
        entry(pending("pb-1", "flow-a", 1, undefined, 1_000), atStep(2)),
        entry(pending("pb-2", "flow-b", 2, undefined, 2_000), atStep(2)),
      ]);

      store.getState().remove("pb-1");

      expect(selectBuildingCards(store.getState()).map((card) => card.pendingId)).toEqual(["pb-2"]);
      expect(selectBuildingCount(store.getState())).toBe(1);
    });

    it("shows no older ended build of a name once its latest ended build is removed", async () => {
      const { store } = await setup([
        entry({ ...pending("pb-older", "flow-a", 1, "failed", 1_000), endedAt: 2_000 }, atStep(3)),
        entry(
          { ...pending("pb-newer", "flow-a", 1, "needs-you", 1_500), endedAt: 3_000 },
          atStep(3),
        ),
      ]);
      expect(selectBuildingCards(store.getState()).map((card) => card.pendingId)).toEqual([
        "pb-newer",
      ]);

      store.getState().remove("pb-newer");

      expect(selectBuildingCards(store.getState())).toEqual([]);
    });

    it("has no cards and a count of none before any build", async () => {
      const { store } = await setup([]);

      expect(selectBuildingCards(store.getState())).toEqual([]);
      expect(selectBuildingCount(store.getState())).toBe(0);
    });
  });

  describe("whether a blueprint is being built", () => {
    it("is true while a build of the blueprint has not ended, and false once it has", async () => {
      const { store, push } = await setup([entry(pending("pb-1", "flow-a", 1), atStep(2))]);

      expect(selectFlowBuilding("flow-a")(store.getState())).toBe(true);

      push(entry(pending("pb-1", "flow-a", 1, "failed"), atStep(2)));

      expect(selectFlowBuilding("flow-a")(store.getState())).toBe(false);
    });

    it("is false for a blueprint while only another one is being built", async () => {
      const { store } = await setup([entry(pending("pb-1", "flow-a", 1), atStep(2))]);

      expect(selectFlowBuilding("flow-b")(store.getState())).toBe(false);
    });
  });

  describe("a build's pipeline", () => {
    const events: BuildEvent[] = [
      ...atStep(3),
      { type: "component", path: "agents/c.md", kind: "agent", nodeIds: ["n1"], status: "running" },
    ];
    const inWrite = { ...subagent(1, "agents/c.md", "running"), at: 1_450 };

    it("projects the build's own events and activity", async () => {
      const build = pending("pb-1", "flow-a", 1);
      const { store } = await setup([entry(build, events)], [inWrite]);
      await store.getState().viewActivity("pb-1");

      const pipeline = selectPipeline("pb-1")(store.getState());

      expect(pipeline).toEqual(
        buildPipelineOf({ id: "pb-1", name: "v1", startedAt: 1_000 }, stored(events), [inWrite]),
      );
      const write = pipeline?.lanes.find((lane) => lane.step === 3 && lane.round === 1);
      expect(write?.rows.map((row) => [row.path, row.log])).toEqual([["agents/c.md", [inWrite]]]);
    });

    it("carries the build's end into the pipeline's header", async () => {
      const build = pending("pb-1", "flow-a", 1, "built");
      const { store } = await setup([entry(build, atStep(5), "b-1")]);

      expect(selectPipeline("pb-1")(store.getState())?.header).toMatchObject({
        name: "v1",
        startedAt: 1_000,
        endedAt: 9_000,
        status: "built",
      });
    });

    it("leaves out another build's activity", async () => {
      const { store, pushActivity } = await setup([
        entry(pending("pb-1", "flow-a", 1), events),
        entry(pending("pb-2", "flow-a", 1), events),
      ]);

      pushActivity({ pendingId: "pb-2", entry: inWrite });

      const write = selectPipeline("pb-1")(store.getState())?.lanes.find((lane) => lane.step === 3);
      expect(write?.log).toEqual([]);
      expect(
        selectPipeline("pb-2")(store.getState())?.lanes.find((lane) => lane.step === 3)?.log,
      ).toEqual([inWrite]);
    });

    it("has no pipeline for a build it was never told of", async () => {
      const { store } = await setup([entry(pending("pb-1", "flow-a", 1), events)]);

      expect(selectPipeline("pb-404")(store.getState())).toBeUndefined();
    });
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

  it("ignores a push or a list it cannot read", async () => {
    const { store, push } = await setup({ nope: true });

    push({ pendingId: "pb-1" });

    expect(store.getState().progressFor("pb-1")).toBeUndefined();
    push(entry(pending("pb-1", "flow-a", 1), atStep(2)));
    expect(store.getState().progressFor("pb-1")?.chip).toBe("Building · step 2 of 5");
  });
});
