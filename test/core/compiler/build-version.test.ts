import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layDown, type BuildResult } from "../../../src/core/compiler/build.js";
import { emptyReport, type BuildReport } from "../../../src/core/compiler/build-report.js";
import {
  buildResumeOf,
  buildVersion,
  runBuild,
  startBuild,
  type BuildOrigin,
  type StartedBuild,
} from "../../../src/core/compiler/build-version.js";
import { sha256Hex } from "../../../src/core/compiler/hash.js";
import type { Manifest } from "../../../src/core/compiler/lower.js";
import { markerOf } from "../../../src/core/run/agent-calls.js";
import type { BuildEvent } from "../../../src/core/run/build-progress.js";
import type { PendingBuildEnd } from "../../../src/core/run/store.js";
import type { BuildConfig, Flow } from "../../../src/core/flow/schema.js";
import type { BuildAgents } from "../../../src/ports/build-agents.js";
import type { FolderState } from "../../../src/ports/git-state.js";
import type { WorktreeAddOptions } from "../../../src/ports/worktree.js";
import { FakeBuildAgents, type FakeBuildScript } from "../../fakes/fake-build-agents.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { agent, flow, prompt, script, thenWire } from "../../fixtures/flow-builders.js";

const repo = "/work/carousell-web";
const ticketConfig: BuildConfig = {
  repo,
  base: "main",
  variables: [{ name: "ticket", kind: "text" }],
};

const withConfig = (base: Flow, buildConfig: BuildConfig): Flow => ({
  ...base,
  session: { ...base.session, buildConfig },
});

const ticketFlow = (buildConfig: BuildConfig = ticketConfig) =>
  withConfig(
    flow([prompt("p1", { settings: { instructions: "Fix {{ticket}}" } })], []),
    buildConfig,
  );

const ids = (...values: string[]) => {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no ids left");
    return next;
  };
};

const firstId = "0f3a9c2e-1111-2222-3333-444455556666";
const secondId = "7b1d44aa-1111-2222-3333-444455556666";

const startedAt = 1700;

const sessionName = "fd-build-Ab12Cd34";
const kit = { dir: "/flowdeck-kit", version: "kit-3f9a" };
const settingsFolder = `/flowdeck-home/build-sessions/${sessionName}`;
const settingsPath = `${settingsFolder}/settings.json`;

const step = (number: 1 | 2 | 3 | 4 | 5, status: "running" | "done" | "failed" | "skipped") => ({
  type: "step",
  step: number,
  status,
});

const throughStep4 = [
  step(1, "running"),
  step(1, "done"),
  step(2, "running"),
  step(2, "done"),
  step(3, "running"),
  step(3, "done"),
  step(4, "running"),
  step(4, "done"),
];

const builtSteps = [...throughStep4, step(5, "running"), step(5, "done")];

const failedAtStep5 = (message: string) => [
  ...throughStep4,
  step(5, "running"),
  { ...step(5, "failed"), message },
];

const eventsOf = (store: FakeStore, pendingId: string) =>
  store.buildEvents(pendingId).map((stored) => {
    const event: Partial<typeof stored> = { ...stored };
    delete event.seq;
    delete event.at;
    return event;
  });

type StepEvent = Extract<BuildEvent, { type: "step" }>;

const stepsOf = (store: FakeStore, pendingId: string): Omit<StepEvent, "round">[] =>
  store
    .buildEvents(pendingId)
    .filter((event): event is StepEvent & { seq: number; at: number } => event.type === "step")
    .map(({ type, step, status, message }) => ({
      type,
      step,
      status,
      ...(message === undefined ? {} : { message }),
    }));

const endsOf = (store: FakeStore) => {
  const ends: { pendingId: string; end: PendingBuildEnd }[] = [];
  const end = store.endPendingBuild.bind(store);
  store.endPendingBuild = (pendingId, value) => {
    ends.push({ pendingId, end: value });
    end(pendingId, value);
  };
  return ends;
};

const errorMessages = (
  result: Awaited<ReturnType<typeof buildVersion>> | Awaited<ReturnType<typeof startBuild>>,
): string[] => ("errors" in result ? result.errors.map((error) => error.message) : []);

describe("buildVersion", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-build-version-")));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const setup = (
    options: {
      flows?: Flow[];
      states?: Record<string, FolderState>;
      defaultBranches?: Record<string, string>;
      worktree?: FakeWorktree;
      newId?: () => string;
      script?: FakeBuildScript;
    } = {},
  ) => {
    const flows = new FakeFlowStore({ newId: () => "flow-1" });
    for (const saved of options.flows ?? [ticketFlow()]) flows.save(saved);
    const store = new FakeStore();
    const fs = new FakeFileSystem();
    const gitState = new FakeGitState(
      options.states ?? { [repo]: { kind: "branch", name: "main" } },
      {
        defaultBranches: options.defaultBranches ?? {},
      },
    );
    const worktree = options.worktree ?? new FakeWorktree();
    const newId = options.newId ?? ids(firstId, secondId);
    const agents = new FakeBuildAgents({
      fs,
      ...(options.script === undefined ? {} : { script: options.script }),
    });
    return {
      flows,
      store,
      fs,
      gitState,
      worktree,
      agents,
      deps: {
        flows,
        store,
        fs,
        gitState,
        worktree,
        newId,
        home,
        now: () => startedAt,
        agents,
        kit,
        sessionName: () => sessionName,
        newSessionId: () => "claude-session-1",
        settingsPath,
        guardCommand: "flowdeck-build-guard",
        hookCommand: "flowdeck-hook",
      },
    };
  };

  const v1 = { flowId: "flow-1", version: 1 };

  const expectNothingDone = (store: FakeStore, fs: FakeFileSystem, worktree: FakeWorktree) => {
    expect(store.builds()).toEqual([]);
    expect(fs.calls.filter((call) => call.method === "writeFile")).toEqual([]);
    expect(worktree.calls).toEqual([]);
  };

  describe("a named build", () => {
    it("makes the workspace under the new id, cuts its worktree there and records the build", async () => {
      const { store, fs, worktree, deps } = setup();

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } },
        deps,
      );

      if (!result.ok) throw new Error(`build failed: ${errorMessages(result).join("; ")}`);
      const dir = `${home}/workspaces/${firstId}`;
      expect(result.dir).toBe(dir);
      expect(await fs.exists(`${dir}/manifest.json`)).toBe(true);
      expect(worktree.calls).toEqual([
        { repo, base: "main", branch: "flowdeck/fix-login-0f3a9c2e", path: `${dir}/carousell-web` },
      ]);
      expect(store.builds()).toEqual([
        expect.objectContaining({
          id: firstId,
          hash: result.hash,
          name: "fix-login",
          repo,
          base: "main",
          values: { ticket: "FD-1" },
          dir,
          source: v1,
        }),
      ]);
    });

    it("writes the workspace before the worktree, and records the build only after both", async () => {
      const seen: { manifest: boolean; recorded: number }[] = [];
      const base = setup();
      const worktree = new (class extends FakeWorktree {
        override async add(options: WorktreeAddOptions): Promise<void> {
          seen.push({
            manifest: await base.fs.exists(`${home}/workspaces/${firstId}/manifest.json`),
            recorded: base.store.builds().length,
          });
          await super.add(options);
        }
      })();

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } },
        { ...base.deps, worktree },
      );

      expect(result.ok).toBe(true);
      expect(seen).toEqual([{ manifest: true, recorded: 0 }]);
      expect(base.store.builds()).toHaveLength(1);
    });

    it("leaves no workspace folder and no row when the worktree cannot be made", async () => {
      const { store, fs, worktree, deps } = setup({
        worktree: new FakeWorktree({ failWith: "git said no" }),
      });

      await expect(
        buildVersion(
          v1,
          { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } },
          deps,
        ),
      ).rejects.toThrow("git said no");

      expect(store.builds()).toEqual([]);
      expect(await fs.exists(`${home}/workspaces/${firstId}/manifest.json`)).toBe(false);
      expect(worktree.removed).toEqual([]);
    });

    it("removes the worktree it cut and the workspace folder when the build cannot be recorded", async () => {
      const base = setup();
      const store = Object.assign(base.store, {
        recordBuild: () => {
          throw new Error("disk full");
        },
      });
      const dir = `${home}/workspaces/${firstId}`;

      await expect(
        buildVersion(
          v1,
          { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } },
          { ...base.deps, store },
        ),
      ).rejects.toThrow("disk full");

      expect(base.worktree.removed).toEqual([
        { repo, base: "main", branch: "flowdeck/fix-login-0f3a9c2e", path: `${dir}/carousell-web` },
      ]);
      expect(await base.fs.exists(`${dir}/manifest.json`)).toBe(false);
    });

    it("builds one version as two named builds with their own workspaces and worktrees", async () => {
      const { store, worktree, deps } = setup();

      const a = await buildVersion(v1, { name: "a", repo, values: { ticket: "FD-1" } }, deps);
      const b = await buildVersion(v1, { name: "b", repo, values: { ticket: "FD-1" } }, deps);

      if (!a.ok || !b.ok) throw new Error("build failed");
      expect(a.dir).toBe(`${home}/workspaces/${firstId}`);
      expect(b.dir).toBe(`${home}/workspaces/${secondId}`);
      expect(worktree.calls.map(({ branch, path }) => ({ branch, path }))).toEqual([
        { branch: "flowdeck/a-0f3a9c2e", path: `${home}/workspaces/${firstId}/carousell-web` },
        { branch: "flowdeck/b-7b1d44aa", path: `${home}/workspaces/${secondId}/carousell-web` },
      ]);
      expect(store.builds().map(({ id, name }) => ({ id, name }))).toEqual([
        { id: firstId, name: "a" },
        { id: secondId, name: "b" },
      ]);
    });

    it("takes a name again once the build that had it is deleted", async () => {
      const { store, deps } = setup();
      const first = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );
      if (!first.ok) throw new Error("build failed");
      store.deleteBuild(firstId);

      const again = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-2" } },
        deps,
      );

      expect(again.ok).toBe(true);
      expect(store.findBuildByName("fix-login")?.id).toBe(secondId);
    });

    it("accepts a variable left empty in the dialog when the blueprint gives it a default", async () => {
      const { deps } = setup({
        flows: [
          ticketFlow({
            ...ticketConfig,
            variables: [{ name: "ticket", kind: "text", default: "FD-0" }],
          }),
        ],
      });

      const result = await buildVersion(v1, { name: "fix-login", repo, values: {} }, deps);

      expect(errorMessages(result)).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });

  describe("startBuild", () => {
    const request = { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } };

    const savedV1 = (flows: FakeFlowStore) => {
      const saved = flows.load(v1);
      if (saved === null) throw new Error("nothing saved");
      const origin: BuildOrigin = {
        source: v1,
        blueprint: { name: saved.name, version: saved.version },
      };
      return { flow: saved.flow, origin };
    };

    it("reserves the name and returns at once, before anything is laid down", async () => {
      const { flows, store, fs, worktree, deps } = setup();
      const { flow: saved, origin } = savedV1(flows);

      const started = await startBuild(saved, request, deps, origin);

      expect(started).toEqual({ kind: "started", pendingId: expect.any(String) });
      if (!("kind" in started)) throw new Error("not started");
      expect(store.listPendingBuilds()).toEqual([
        expect.objectContaining({
          id: started.pendingId,
          flowId: "flow-1",
          version: 1,
          name: "fix-login",
          startedAt,
        }),
      ]);
      expect(store.buildEvents(started.pendingId)).toEqual([]);
      expectNothingDone(store, fs, worktree);
    });

    it("reserves a flow given as a file under its build name, as version 1", async () => {
      const { store, deps } = setup();

      await startBuild(ticketFlow(), request, deps);

      expect(store.listPendingBuilds()).toEqual([
        expect.objectContaining({ flowId: "file:fix-login", version: 1, name: "fix-login" }),
      ]);
    });

    it("refuses a name an open build holds, naming it, and reserves nothing", async () => {
      const { flows, store, fs, worktree, deps } = setup();
      store.startPendingBuild({
        flowId: "flow-2",
        version: 1,
        name: "fix-login",
        origin: {},
        startedAt: 1,
      });
      const { flow: saved, origin } = savedV1(flows);

      const result = await startBuild(saved, request, deps, origin);

      expect(result).toEqual({ ok: false, errors: [expect.anything()] });
      expect(errorMessages(result).join("\n")).toContain("fix-login");
      expect(store.listPendingBuilds()).toHaveLength(1);
      expectNothingDone(store, fs, worktree);
    });

    it("refuses a name an open build holds before reading the repo, even a missing one", async () => {
      const { flows, store, gitState, deps } = setup({ states: {} });
      store.startPendingBuild({
        flowId: "flow-2",
        version: 1,
        name: "fix-login",
        origin: {},
        startedAt: 1,
      });
      const { flow: saved, origin } = savedV1(flows);

      const result = await startBuild(saved, request, deps, origin);

      expect(errorMessages(result)).toEqual(["A build named fix-login is already building."]);
      expect(gitState.reads).toEqual([]);
    });

    it("refuses while the blueprint is already building, and reserves nothing", async () => {
      const { flows, store, fs, worktree, deps } = setup();
      store.startPendingBuild({
        flowId: "flow-1",
        version: 1,
        name: "other",
        origin: {},
        startedAt: 1,
      });
      const { flow: saved, origin } = savedV1(flows);

      const result = await startBuild(saved, request, deps, origin);

      expect(result).toEqual({ ok: false, errors: [expect.anything()] });
      expect(store.listPendingBuilds().map((pending) => pending.name)).toEqual(["other"]);
      expectNothingDone(store, fs, worktree);
    });

    it("refuses a connector Claude Code lacks before reserving anything", async () => {
      const { store, fs, worktree, deps } = setup();
      const withConnector: Flow = {
        ...ticketFlow(),
        session: { ...ticketFlow().session, connectors: ["jira"] },
      };
      const noConnectors = { find: async () => undefined, list: async () => ({}) };

      const result = await startBuild(withConnector, request, {
        ...deps,
        connectors: noConnectors,
      });

      expect(errorMessages(result)).toEqual([
        expect.stringMatching(/^Connector "jira" is not set up in Claude Code/),
      ]);
      expect(store.listPendingBuilds()).toEqual([]);
      expectNothingDone(store, fs, worktree);
    });

    it("refuses a name that is not kebab-case before reserving anything", async () => {
      const { flows, store, fs, worktree, deps } = setup();
      const { flow: saved, origin } = savedV1(flows);

      const result = await startBuild(saved, { ...request, name: "Fix-Login" }, deps, origin);

      expect(result).toEqual({ ok: false, errors: [expect.anything()] });
      expect(store.listPendingBuilds()).toEqual([]);
      expectNothingDone(store, fs, worktree);
    });
  });

  describe("runBuild", () => {
    const request = { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } };

    const started = async (base: ReturnType<typeof setup>): Promise<StartedBuild> => {
      const result = base.store.startPendingBuild({
        flowId: "file:fix-login",
        version: 1,
        name: "fix-login",
        origin: {},
        startedAt,
      });
      if (result.kind !== "started") throw new Error("pending build not started");
      return result;
    };

    it("runs all five steps and ends the build built", async () => {
      const base = setup();
      const ends = endsOf(base.store);
      const observed: { pendingId: string; event: BuildEvent }[] = [];
      const deps = {
        ...base.deps,
        onEvent: (pendingId: string, event: BuildEvent) => observed.push({ pendingId, event }),
      };
      const pending = await started(base);

      const result = await runBuild(pending, ticketFlow(), request, deps);

      expect(stepsOf(base.store, pending.pendingId)).toEqual(builtSteps);
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(observed.map(({ event }) => event)).toEqual(eventsOf(base.store, pending.pendingId));
      expect(new Set(observed.map(({ pendingId }) => pendingId))).toEqual(
        new Set([pending.pendingId]),
      );
      expect(ends).toEqual([
        {
          pendingId: pending.pendingId,
          end: expect.objectContaining({ outcome: "built", buildId: firstId, endedAt: startedAt }),
        },
      ]);
      expect(base.store.builds().map((build) => build.id)).toEqual([firstId]);
      expect(base.store.listPendingBuilds()).toEqual([]);
    });

    it("ends the build only once its worktree is cut and the build recorded", async () => {
      const base = setup();
      const seen: { worktrees: number; recorded: number }[] = [];
      const end = base.store.endPendingBuild.bind(base.store);
      base.store.endPendingBuild = (pendingId, value) => {
        seen.push({ worktrees: base.worktree.calls.length, recorded: base.store.builds().length });
        end(pendingId, value);
      };
      const pending = await started(base);

      await runBuild(pending, ticketFlow(), request, base.deps);

      expect(seen).toEqual([{ worktrees: 1, recorded: 1 }]);
    });

    it("fails step 2 on a throw while laying down, ending the build failed and keeping its events", async () => {
      const base = setup();
      const ends = endsOf(base.store);
      const withConnector: Flow = {
        ...ticketFlow(),
        session: { ...ticketFlow().session, connectors: ["jira"] },
      };
      const deps = {
        ...base.deps,
        connectors: {
          find: async () => {
            throw new Error("keychain locked");
          },
          list: async () => ({}),
        },
      };
      const pending = await started(base);

      await expect(runBuild(pending, withConnector, request, deps)).rejects.toThrow(
        "keychain locked",
      );

      expect(stepsOf(base.store, pending.pendingId)).toEqual([
        step(1, "running"),
        step(1, "done"),
        step(2, "running"),
        { ...step(2, "failed"), message: "keychain locked" },
      ]);
      expect(ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "failed" }) },
      ]);
      expect(base.worktree.calls).toEqual([]);
      expect(base.store.builds()).toEqual([]);
    });

    it("fails step 5 when the worktree cannot be cut, removing the workspace and keeping the report", async () => {
      const base = setup({ worktree: new FakeWorktree({ failWith: "git said no" }) });
      const ends = endsOf(base.store);
      const pending = await started(base);

      await expect(runBuild(pending, ticketFlow(), request, base.deps)).rejects.toThrow(
        "git said no",
      );

      expect(stepsOf(base.store, pending.pendingId)).toEqual(failedAtStep5("git said no"));
      expect(ends).toEqual([
        {
          pendingId: pending.pendingId,
          end: expect.objectContaining({
            outcome: "failed",
            endedAt: startedAt,
            report: emptyReport(),
          }),
        },
      ]);
      expect(await base.fs.exists(`${home}/workspaces/${firstId}/manifest.json`)).toBe(false);
      expect(base.store.builds()).toEqual([]);
      expect(base.worktree.removed).toEqual([]);
    });

    it("records a refused lay-down's problems on the failed step", async () => {
      const base = setup();
      const withConnector: Flow = {
        ...ticketFlow(),
        session: { ...ticketFlow().session, connectors: ["jira"] },
      };
      const pending = await started(base);

      const result = await runBuild(pending, withConnector, request, base.deps);

      if (result.ok) throw new Error("built with a connector Claude Code lacks");
      expect(result.errors).not.toEqual([]);
      expect(eventsOf(base.store, pending.pendingId).at(-1)).toEqual({
        type: "step",
        step: 2,
        status: "failed",
        message: result.errors.map((error) => error.message).join("\n"),
      });
    });

    it("records the thrown error's message on the failed step", async () => {
      const base = setup({ worktree: new FakeWorktree({ failWith: "git said no" }) });
      const pending = await started(base);

      await runBuild(pending, ticketFlow(), request, base.deps).catch(() => undefined);

      expect(eventsOf(base.store, pending.pendingId).at(-1)).toEqual({
        type: "step",
        step: 5,
        status: "failed",
        message: "git said no",
      });
    });

    it("fails step 5 when the build cannot be recorded, removing the worktree it cut", async () => {
      const base = setup();
      const ends = endsOf(base.store);
      base.store.recordBuild = () => {
        throw new Error("disk full");
      };
      const pending = await started(base);
      const dir = `${home}/workspaces/${firstId}`;

      await expect(runBuild(pending, ticketFlow(), request, base.deps)).rejects.toThrow(
        "disk full",
      );

      expect(stepsOf(base.store, pending.pendingId)).toEqual(failedAtStep5("disk full"));
      expect(ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "failed" }) },
      ]);
      expect(base.worktree.removed).toEqual([
        { repo, base: "main", branch: "flowdeck/fix-login-0f3a9c2e", path: `${dir}/carousell-web` },
      ]);
      expect(await base.fs.exists(`${dir}/manifest.json`)).toBe(false);
    });

    it("releases the name of a failed build, keeping its events", async () => {
      const base = setup({ worktree: new FakeWorktree({ failWith: "git said no" }) });
      const pending = await started(base);
      await runBuild(pending, ticketFlow(), request, base.deps).catch(() => undefined);

      const again = await startBuild(ticketFlow(), request, base.deps);

      expect(again).toEqual({ kind: "started", pendingId: expect.any(String) });
      expect(stepsOf(base.store, pending.pendingId)).toEqual(failedAtStep5("git said no"));
    });
  });

  describe("runBuild through the build agents", () => {
    const request = { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } };
    const dir = () => `${home}/workspaces/${firstId}`;

    const labelled = <T extends { label: string }>(node: T, label: string): T => ({
      ...node,
      label,
    });

    const agentsFlow = (buildConfig: BuildConfig = ticketConfig): Flow =>
      withConfig(
        flow(
          [
            labelled(
              prompt("p1", { settings: { instructions: "Fix {{ticket}}" } }),
              "Draft the fix",
            ),
            labelled(agent("a"), "Review the fix"),
            labelled(agent("b"), "Review the fix again"),
          ],
          [thenWire("p1", "a"), thenWire("a", "b")],
        ),
        buildConfig,
      );

    const pieceOf = async (nodeId: string): Promise<string> => {
      const laid = await layDown(agentsFlow(), {
        home,
        workspace: { id: firstId, name: request.name, repo, base: "main", values: request.values },
      });
      if (!laid.ok) throw new Error("the flow does not lay down");
      const manifest = JSON.parse(
        laid.files.find((file) => file.path === "manifest.json")?.content ?? "{}",
      ) as Manifest;
      const file = manifest.nodes.find((node) => node.id === nodeId)?.file;
      if (file === undefined) throw new Error(`no piece for ${nodeId}`);
      return file;
    };

    const isWriteTurn = (text: string) => text.includes("flowdeck-build:piece-auditor");
    const isAuditTurn = (text: string) => text.includes("flowdeck-build:handoff-auditor");
    const piecesNamed = (text: string) =>
      text
        .split("\n")
        .map(markerOf)
        .flatMap((marker) => ("piece" in marker ? [marker.piece] : []));

    const traced = (
      options: {
        script?: FakeBuildScript;
        afterAudit?: BuildReport["questions"];
        signal?: AbortSignal;
      } = {},
    ) => {
      const base = setup({
        flows: [agentsFlow()],
        ...(options.script === undefined ? {} : { script: options.script }),
      });
      const timeline: string[] = [];
      const fake = base.agents;
      const agents: BuildAgents = {
        open: async (spec) => {
          timeline.push("open");
          await fake.open(spec);
        },
        turn: async (name, text, onCall) => {
          timeline.push(isAuditTurn(text) ? "audit turn" : "write turn");
          const result = await fake.turn(name, text, onCall);
          if (isAuditTurn(text) && options.afterAudit !== undefined) {
            const report: BuildReport = { ...emptyReport(), questions: options.afterAudit };
            await base.fs.writeFile(`${dir()}/build-report.json`, JSON.stringify(report));
          }
          return result;
        },
        alive: (name) => fake.alive(name),
        close: async (name) => {
          timeline.push("close");
          await fake.close(name);
        },
      };
      const writeFile = base.fs.writeFile.bind(base.fs);
      base.fs.writeFile = async (path, content) => {
        if (path === `${dir()}/manifest.json`) timeline.push("write manifest.json");
        await writeFile(path, content);
      };
      const add = base.worktree.add.bind(base.worktree);
      base.worktree.add = async (worktreeOptions) => {
        timeline.push("worktree.add");
        await add(worktreeOptions);
      };
      const recordBuild = base.store.recordBuild.bind(base.store);
      base.store.recordBuild = (record) => {
        timeline.push("recordBuild");
        recordBuild(record);
      };
      const ends = endsOf(base.store);
      const end = base.store.endPendingBuild.bind(base.store);
      base.store.endPendingBuild = (pendingId, value) => {
        timeline.push(`end ${value.outcome}`);
        end(pendingId, value);
      };
      const onEvent = (_pendingId: string, event: BuildEvent) => {
        if (event.type === "step") timeline.push(`step ${event.step} ${event.status}`);
        if (event.type === "session") timeline.push(`session ${event.name}`);
        if (event.type === "component") timeline.push(`component ${event.path} ${event.status}`);
      };
      const deps = {
        ...base.deps,
        agents,
        onEvent,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const run = async (source: Flow = agentsFlow()) => {
        const pending = base.store.startPendingBuild({
          flowId: "file:fix-login",
          version: 1,
          name: request.name,
          origin: {},
          startedAt,
        });
        if (pending.kind !== "started") throw new Error("pending build not started");
        const result = await runBuild(pending, source, request, deps).catch(
          (error: unknown) => error,
        );
        return { pending, result };
      };
      return { ...base, fake, timeline, ends, deps, run };
    };

    const expectInOrder = (timeline: readonly string[], expected: readonly string[]) => {
      let from = 0;
      for (const entry of expected) {
        const at = timeline.indexOf(entry, from);
        expect(
          at,
          `"${entry}" at or after ${from} in ${JSON.stringify(timeline)}`,
        ).toBeGreaterThanOrEqual(from);
        from = at + 1;
      }
    };

    const isBuilt = (result: unknown): result is Extract<BuildResult, { ok: true }> =>
      typeof result === "object" && result !== null && "ok" in result && result.ok === true;

    const writeTurns = (fake: FakeBuildAgents) =>
      fake.turns.filter((turn) => isWriteTurn(turn.text));

    const expectSettingsGone = async (t: ReturnType<typeof traced>) => {
      const writes = t.fs.calls.filter((call) => call.method === "writeFile");
      expect(writes.map((call) => call.path)).toContain(settingsPath);
      expect(await t.fs.exists(settingsFolder)).toBe(false);
    };

    const expectTornDown = async (t: ReturnType<typeof traced>) => {
      expect(t.fake.closed).toEqual([sessionName]);
      expect(await t.fs.exists(`${dir()}/manifest.json`)).toBe(false);
      expect(t.worktree.calls).toEqual([]);
      expect(t.store.builds()).toEqual([]);
      await expectSettingsGone(t);
    };

    it("lays down, opens the session, writes, audits, checks, locks, cuts, records, closes, then ends built", async () => {
      const t = traced();
      const pieceA = await pieceOf("a");

      const { result } = await t.run();

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expectInOrder(t.timeline, [
        "step 1 running",
        "step 1 done",
        "step 2 running",
        "write manifest.json",
        "step 2 done",
        `session ${sessionName}`,
        "step 3 running",
        "write turn",
        `component ${pieceA} running`,
        `component ${pieceA} done`,
        "step 3 done",
        "step 4 running",
        "audit turn",
        "step 4 done",
        "step 5 running",
        "write manifest.json",
        "worktree.add",
        "recordBuild",
        "close",
        "end built",
      ]);
      expect(t.timeline.indexOf("open")).toBeLessThan(t.timeline.indexOf("write turn"));
      expect(t.timeline.indexOf("open")).toBeGreaterThan(t.timeline.indexOf("step 2 done"));
      await expectSettingsGone(t);
    });

    it("opens the build session in the workspace with the kit, the settings and the session name", async () => {
      const t = traced();

      await t.run();

      expect(t.fake.opened).toEqual([
        expect.objectContaining({
          sessionName,
          workspaceDir: dir(),
          kitDir: kit.dir,
          settingsPath,
        }),
      ]);
      expect(t.fake.turns.every((turn) => turn.sessionName === sessionName)).toBe(true);
    });

    it("has the laid-down files on disk when the session opens", async () => {
      const t = traced();
      const pieceA = await pieceOf("a");
      const seen: string[] = [];
      const open = t.deps.agents.open;
      t.deps.agents.open = async (spec) => {
        seen.push(await t.fs.readFile(`${spec.workspaceDir}/${pieceA}`));
        await open(spec);
      };

      await t.run();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^@unfilled/m);
    });

    it("emits a component event per agent call, naming the piece's kind and nodes", async () => {
      const t = traced();
      const pieceA = await pieceOf("a");

      const { pending } = await t.run();

      const components = eventsOf(t.store, pending.pendingId).filter(
        (event) =>
          event.type === "component" && event.path === pieceA && event.status !== "waiting",
      );
      expect(components.slice(0, 2)).toEqual([
        { type: "component", path: pieceA, kind: "agent", nodeIds: ["a"], status: "running" },
        { type: "component", path: pieceA, kind: "agent", nodeIds: ["a"], status: "done" },
      ]);
    });

    it("marks every piece of round 1 waiting when step 3 starts, before any agent call", async () => {
      const t = traced();
      const pieces = await Promise.all(["p1", "a", "b"].map(pieceOf));

      const { pending } = await t.run();

      const events = eventsOf(t.store, pending.pendingId);
      const start = events.findIndex(
        (event) => event.type === "step" && event.step === 3 && event.status === "running",
      );
      const firstCall = events.findIndex(
        (event) => event.type === "component" && event.status !== "waiting",
      );
      const waiting = events.filter(
        (event) => event.type === "component" && event.status === "waiting",
      );
      expect(waiting.map((event) => (event.type === "component" ? event.path : "")).sort()).toEqual(
        [...pieces].sort(),
      );
      expect(waiting).toContainEqual({
        type: "component",
        path: pieces[1],
        kind: "agent",
        nodeIds: ["a"],
        status: "waiting",
      });
      expect(waiting.every((event) => events.indexOf(event) > start)).toBe(true);
      expect(waiting.every((event) => events.indexOf(event) < firstCall)).toBe(true);
    });

    it("marks only the pieces a later round rewrites waiting again", async () => {
      const pieceA = await pieceOf("a");
      const t = traced({ script: { leaveMarker: [{ path: pieceA, rounds: [1] }] } });

      const { pending } = await t.run();

      const events = eventsOf(t.store, pending.pendingId);
      const round2 = events.findIndex(
        (event) =>
          event.type === "step" &&
          event.step === 3 &&
          event.status === "running" &&
          event.round === 2,
      );
      expect(round2).toBeGreaterThan(-1);
      const waitingAfter = events
        .slice(round2)
        .filter((event) => event.type === "component" && event.status === "waiting");
      expect(waitingAfter).toEqual([
        { type: "component", path: pieceA, kind: "agent", nodeIds: ["a"], status: "waiting" },
      ]);
    });

    it("writes every piece in round 1, then audits the workspace", async () => {
      const t = traced();
      const pieces = await Promise.all(["p1", "a", "b"].map(pieceOf));

      await t.run();

      expect(t.fake.turns).toHaveLength(2);
      const [write, audit] = t.fake.turns;
      expect(isWriteTurn(write?.text ?? "")).toBe(true);
      expect([...piecesNamed(write?.text ?? "")].sort()).toEqual([...pieces].sort());
      expect(isAuditTurn(audit?.text ?? "")).toBe(true);
      expect(piecesNamed(audit?.text ?? "")).toEqual(["workspace"]);
    });

    it("locks the filled files after the agents, with the kit version in the manifest", async () => {
      const t = traced();
      const pieceA = await pieceOf("a");

      const { result } = await t.run();

      if (!isBuilt(result)) throw new Error(`build failed: ${String(result)}`);
      const filled = await t.fs.readFile(`${dir()}/${pieceA}`);
      expect(filled).not.toMatch(/@unfilled/);
      const manifest = JSON.parse(await t.fs.readFile(`${dir()}/manifest.json`)) as Manifest & {
        hash: string;
      };
      expect(manifest.kitVersion).toBe(kit.version);
      expect(manifest.hash).toBe(result.hash);
      expect(manifest.files[pieceA]).toBe(sha256Hex(filled));
      expect(t.store.builds()).toEqual([expect.objectContaining({ hash: result.hash })]);
    });

    it("applies the merges, then audits the merged piece once more in one write turn", async () => {
      const t = traced({
        script: { merges: [{ nodeIds: ["a", "b"], reason: "Both review the same fix." }] },
      });
      const pieceA = await pieceOf("a");
      const pieceB = await pieceOf("b");

      const { result } = await t.run();

      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(t.fake.turns.map((turn) => (isAuditTurn(turn.text) ? "audit" : "write"))).toEqual([
        "write",
        "audit",
        "write",
      ]);
      expect(piecesNamed(t.fake.turns[2]?.text ?? "")).toEqual([pieceA]);
      expectInOrder(t.timeline, ["audit turn", "write turn", "step 5 running", "end built"]);
      expect(await t.fs.exists(`${dir()}/${pieceB}`)).toBe(false);
      const manifest = JSON.parse(await t.fs.readFile(`${dir()}/manifest.json`)) as Manifest;
      expect(manifest.nodes.find((node) => node.id === "b")?.file).toBe(pieceA);
    });

    it("stopped during the merge writes, ends stopped with no workspace, no worktree and no turn after", async () => {
      const stopping = new AbortController();
      const t = traced({
        script: { merges: [{ nodeIds: ["a", "b"], reason: "Both review the same fix." }] },
        signal: stopping.signal,
      });
      const writeFile = t.fs.writeFile.bind(t.fs);
      t.fs.writeFile = async (path, content) => {
        if (
          t.timeline.includes("audit turn") &&
          path.startsWith(dir()) &&
          !path.endsWith("/build-report.json")
        )
          stopping.abort();
        await writeFile(path, content);
      };

      const { pending, result } = await t.run();

      expect(stopping.signal.aborted).toBe(true);
      expect(result).toEqual({
        ok: false,
        errors: [expect.objectContaining({ rule: "build-stopped" })],
      });
      expect(t.ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "stopped" }) },
      ]);
      expect(t.fake.turns.map((turn) => (isAuditTurn(turn.text) ? "audit" : "write"))).toEqual([
        "write",
        "audit",
      ]);
      expect(await t.fs.list(dir()).catch(() => [])).toEqual([]);
      expect(t.worktree.calls).toEqual([]);
      expect(t.fake.closed).toEqual([sessionName]);
      expect(t.store.builds()).toEqual([]);
    });

    it("sends a round-2 write turn carrying an @unfilled left in round 1, then builds", async () => {
      const pieceA = await pieceOf("a");
      const t = traced({ script: { leaveMarker: [{ path: pieceA, rounds: [1] }] } });

      const { result } = await t.run();

      const writes = writeTurns(t.fake);
      expect(writes.length).toBeGreaterThanOrEqual(2);
      expect(writes[0]?.text).not.toMatch(/FAILED/);
      expect(writes[1]?.text).toContain(`FAILED ${pieceA} unfilled`);
      expect(result).toEqual(expect.objectContaining({ ok: true }));
    });

    it("counts only failed step-5 checks as rounds, building when the third round passes", async () => {
      const pieceA = await pieceOf("a");
      const t = traced({ script: { leaveMarker: [{ path: pieceA, rounds: [1, 2] }] } });

      const { result } = await t.run();

      expect(writeTurns(t.fake)).toHaveLength(3);
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(t.ends).toEqual([
        { pendingId: expect.any(String), end: expect.objectContaining({ outcome: "built" }) },
      ]);
    });

    it("ends the build failed after three failing rounds, tearing down and keeping the report", async () => {
      const pieceA = await pieceOf("a");
      const t = traced({ script: { leaveMarker: [{ path: pieceA }] } });

      await t.run();

      expect(writeTurns(t.fake)).toHaveLength(3);
      expect(t.ends).toEqual([
        {
          pendingId: expect.any(String),
          end: expect.objectContaining({ outcome: "failed", report: emptyReport() }),
        },
      ]);
      await expectTornDown(t);
    });

    it("fails step 5 naming a code-owned file the agents edited, and locks nothing after three rounds", async () => {
      const t = traced({ script: { editCodeOwned: [{ path: "settings.json" }] } });

      const { pending } = await t.run();

      const failedChecks = stepsOf(t.store, pending.pendingId).filter(
        (event) => event.step === 5 && event.status === "failed",
      );
      expect(failedChecks.length).toBeGreaterThan(0);
      expect(failedChecks.at(-1)?.message).toContain("settings.json");
      expect(writeTurns(t.fake)).toHaveLength(3);
      expect(t.ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "failed" }) },
      ]);
      const step5 = t.timeline.indexOf("step 5 running");
      expect(step5).toBeGreaterThanOrEqual(0);
      expect(t.timeline.slice(step5)).not.toContain("write manifest.json");
      await expectTornDown(t);
    });

    it.each<[string, { script?: FakeBuildScript; afterAudit?: BuildReport["questions"] }, number]>([
      ["step 3", { script: { questions: [{ nodeId: "a", text: "Which repo?" }] } }, 1],
      ["step 4", { afterAudit: [{ nodeId: "a", text: "Which repo?" }] }, 2],
    ])(
      "ends the build needs-you on questions after %s, without a round, releasing the name",
      async (_after, options, turns) => {
        const t = traced(options);

        const { pending } = await t.run();

        expect(t.ends).toEqual([
          {
            pendingId: pending.pendingId,
            end: expect.objectContaining({
              outcome: "needs-you",
              report: expect.objectContaining({
                questions: [{ nodeId: "a", text: "Which repo?" }],
              }),
            }),
          },
        ]);
        expect(t.fake.turns).toHaveLength(turns);
        expect(stepsOf(t.store, pending.pendingId).filter((event) => event.step === 5)).toEqual([]);
        await expectTornDown(t);
        expect(await startBuild(agentsFlow(), request, t.deps)).toEqual({
          kind: "started",
          pendingId: expect.any(String),
        });
      },
    );

    it("ends the build needs-you when the audit asks for a merge it cannot apply, asking about it", async () => {
      const t = traced({
        script: { merges: [{ nodeIds: ["p1", "a"], reason: "Both touch the fix." }] },
      });

      const { pending } = await t.run();

      expect(t.ends).toEqual([
        {
          pendingId: pending.pendingId,
          end: expect.objectContaining({
            outcome: "needs-you",
            report: expect.objectContaining({
              questions: [expect.objectContaining({ nodeId: expect.stringMatching(/^(p1|a)$/) })],
            }),
          }),
        },
      ]);
      expect(t.fake.turns).toHaveLength(2);
      expect(stepsOf(t.store, pending.pendingId).filter((event) => event.step === 5)).toEqual([]);
      await expectTornDown(t);
    });

    it("ends the build failed when a turn fails, tearing down", async () => {
      const t = traced({ script: { failTurn: "rate_limit" } });

      const { pending } = await t.run();

      expect(t.ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "failed" }) },
      ]);
      expect(stepsOf(t.store, pending.pendingId).at(-1)).toEqual(
        expect.objectContaining({
          step: 3,
          status: "failed",
          message: expect.stringContaining("rate_limit"),
        }),
      );
      await expectTornDown(t);
    });

    it("closes a session that started but failed to open, ending failed", async () => {
      const t = traced();
      t.deps.agents = {
        ...t.deps.agents,
        open: async (spec) => {
          await t.fake.open(spec);
          throw new Error("the session never became ready");
        },
      };

      const { pending, result } = await t.run();

      expect(result).toEqual(
        expect.objectContaining({ message: "the session never became ready" }),
      );
      expect(t.fake.closed).toEqual([sessionName]);
      expect(await t.fake.alive(sessionName)).toBe(false);
      expect(t.ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "failed" }) },
      ]);
    });

    it("keeps a recorded build built when its session fails to close, and still throws", async () => {
      const t = traced();
      t.deps.agents = {
        ...t.deps.agents,
        close: async (name) => {
          await t.fake.close(name);
          throw new Error("can't find session");
        },
      };

      const { pending, result } = await t.run();

      expect(result).toEqual(expect.objectContaining({ message: "can't find session" }));
      expect(t.store.builds()).toHaveLength(1);
      expect(await t.fs.exists(`${dir()}/manifest.json`)).toBe(true);
      expect(t.ends).toEqual([
        { pendingId: pending.pendingId, end: expect.objectContaining({ outcome: "built" }) },
      ]);
    });

    it("opens the session with the blueprint's build model", async () => {
      const t = traced();

      await t.run(agentsFlow({ ...ticketConfig, buildModel: "haiku" } as BuildConfig));

      expect(t.fake.opened).toEqual([expect.objectContaining({ model: "haiku" })]);
    });
  });

  describe("buildVersion, in stages", () => {
    it("ends its pending build built under the recorded build's id", async () => {
      const { store, deps } = setup();
      const ends = endsOf(store);

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );

      if (!result.ok) throw new Error(`build failed: ${errorMessages(result).join("; ")}`);
      expect(ends).toEqual([
        {
          pendingId: expect.any(String),
          end: expect.objectContaining({ outcome: "built", buildId: result.record.id }),
        },
      ]);
      expect(stepsOf(store, ends[0]?.pendingId ?? "")).toEqual(builtSteps);
    });

    it("refuses while the blueprint is already building", async () => {
      const { store, fs, worktree, deps } = setup();
      store.startPendingBuild({
        flowId: "flow-1",
        version: 1,
        name: "other",
        origin: {},
        startedAt: 1,
      });

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );

      expect(result.ok).toBe(false);
      expectNothingDone(store, fs, worktree);
    });
  });

  describe("a blueprint that names no repo", () => {
    it("builds from the repo and base the request gives, leaving the saved version as it was", async () => {
      const unset: BuildConfig = { variables: ticketConfig.variables };
      const { flows, store, worktree, deps } = setup({ flows: [ticketFlow(unset)] });

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, base: "main", values: { ticket: "FD-1" } },
        deps,
      );

      if (!result.ok) throw new Error(`build failed: ${errorMessages(result).join("; ")}`);
      expect(worktree.calls).toEqual([
        expect.objectContaining({ repo, base: "main", path: `${result.dir}/carousell-web` }),
      ]);
      expect(store.builds()[0]).toEqual(expect.objectContaining({ repo, base: "main" }));
      expect(flows.load(v1)?.flow.session.buildConfig).toEqual(unset);
    });
  });

  describe("the base branch", () => {
    const baseOf = async (
      buildConfig: BuildConfig,
      given: string | undefined,
      defaultBranch?: string,
    ) => {
      const { worktree, deps } = setup({
        flows: [ticketFlow(buildConfig)],
        ...(defaultBranch === undefined ? {} : { defaultBranches: { [repo]: defaultBranch } }),
      });
      const result = await buildVersion(
        v1,
        {
          name: "fix-login",
          repo,
          values: { ticket: "FD-1" },
          ...(given === undefined ? {} : { base: given }),
        },
        deps,
      );
      if (!result.ok) throw new Error(`build failed: ${errorMessages(result).join("; ")}`);
      return worktree.calls[0]?.base;
    };

    it("is the one given, over the blueprint's", async () => {
      expect(await baseOf({ ...ticketConfig, base: "release" }, "develop", "trunk")).toBe(
        "develop",
      );
    });

    it("is the blueprint's when none is given", async () => {
      expect(await baseOf({ ...ticketConfig, base: "release" }, undefined, "trunk")).toBe(
        "release",
      );
    });

    it("is the repo's default branch when neither gives one", async () => {
      expect(await baseOf({ repo, variables: ticketConfig.variables }, undefined, "trunk")).toBe(
        "trunk",
      );
    });

    it("is recorded with the build", async () => {
      const { store, deps } = setup({ flows: [ticketFlow({ ...ticketConfig, base: "release" })] });

      await buildVersion(v1, { name: "fix-login", repo, values: { ticket: "FD-1" } }, deps);

      expect(store.builds()[0]?.base).toBe("release");
    });
  });

  describe("refuses, writing, adding and recording nothing", () => {
    it.each(["Fix-Login", "fix_login", "fix login", "-fix", "fix-", "fix--login", ""])(
      "the name %j, which is not kebab-case",
      async (name) => {
        const { store, fs, worktree, deps } = setup();

        const result = await buildVersion(v1, { name, repo, values: { ticket: "FD-1" } }, deps);

        expect(result.ok).toBe(false);
        expect(errorMessages(result)).not.toEqual([]);
        expectNothingDone(store, fs, worktree);
      },
    );

    it("a name an undeleted build already has, naming it", async () => {
      const { store, fs, worktree, deps } = setup();
      store.recordBuild({
        id: "older",
        hash: "abc",
        name: "fix-login",
        repo,
        base: "main",
        values: {},
        dir: `${home}/workspaces/older`,
        files: [],
        nodes: [],
      });

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );

      expect(result.ok).toBe(false);
      expect(errorMessages(result).join("\n")).toContain("fix-login");
      expect(store.builds().map((build) => build.id)).toEqual(["older"]);
      expect(fs.calls.filter((call) => call.method === "writeFile")).toEqual([]);
      expect(worktree.calls).toEqual([]);
    });

    it.each<[string, FolderState]>([
      ["not a git repository", { kind: "not-a-repo" }],
      ["missing", { kind: "missing" }],
    ])("a repo that is %s, naming the folder", async (_label, state) => {
      const { store, fs, worktree, deps } = setup({ states: { [repo]: state } });

      const result = await buildVersion(
        v1,
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );

      expect(result.ok).toBe(false);
      expect(errorMessages(result).join("\n")).toContain(repo);
      expectNothingDone(store, fs, worktree);
    });

    it("a build with no repo given and none in the blueprint", async () => {
      const { store, fs, worktree, deps } = setup({
        flows: [ticketFlow({ base: "main", variables: ticketConfig.variables })],
      });

      const result = await buildVersion(
        v1,
        { name: "fix-login", values: { ticket: "FD-1" } },
        deps,
      );

      expect(result.ok).toBe(false);
      expect(errorMessages(result)).not.toEqual([]);
      expectNothingDone(store, fs, worktree);
    });

    it.each<[string, Record<string, string>]>([
      ["missing", {}],
      ["empty", { ticket: "" }],
    ])("a variable whose value is %s, naming every unset one", async (_label, values) => {
      const { store, fs, worktree, deps } = setup({
        flows: [
          ticketFlow({
            ...ticketConfig,
            variables: [
              { name: "ticket", kind: "text" },
              { name: "reviewer", kind: "text" },
            ],
          }),
        ],
      });

      const result = await buildVersion(v1, { name: "fix-login", repo, values }, deps);

      expect(result.ok).toBe(false);
      const message = errorMessages(result).join("\n");
      expect(message).toContain("ticket");
      expect(message).toContain("reviewer");
      expectNothingDone(store, fs, worktree);
    });

    it("a version that was never saved", async () => {
      const { store, fs, worktree, deps } = setup();

      const result = await buildVersion(
        { flowId: "flow-1", version: 9 },
        { name: "fix-login", repo, values: { ticket: "FD-1" } },
        deps,
      );

      expect(result).toEqual({
        ok: false,
        errors: [{ rule: "version", message: "flow-1 has no saved version 9" }],
      });
      expectNothingDone(store, fs, worktree);
    });
  });

  describe("the blueprint version", () => {
    const twoVersions = () =>
      setup({
        flows: [
          flow([prompt("p1")], []),
          flow([prompt("p1"), script("s1")], [thenWire("p1", "s1")]),
        ].map((saved) => withConfig(saved, { repo, base: "main", variables: [] })),
      });

    it("builds the chosen version and records it with its flow version", async () => {
      const { store, deps } = twoVersions();

      const result = await buildVersion(v1, { name: "fix-login", repo, values: {} }, deps);

      if (!result.ok) throw new Error("build failed");
      expect(store.builds()).toEqual([result.record]);
      expect(result.record.source).toEqual(v1);
      expect(result.record.nodes.map((node) => node.nodeId)).toEqual(["p1"]);
    });

    it("names only the flow and version in the build, whatever else the reference carries", async () => {
      const { flows, fs, deps } = twoVersions();
      const latest = flows.loadLatest();
      if (latest === null) throw new Error("nothing saved");

      const result = await buildVersion(latest, { name: "fix-login", repo, values: {} }, deps);

      if (!result.ok) throw new Error("build failed");
      expect(result.record.source).toEqual({ flowId: "flow-1", version: 2 });
      const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
      expect(manifest.source).toEqual({ flowId: "flow-1", version: 2 });
    });

    it("gives each version its own build", async () => {
      const { store, deps } = twoVersions();

      await buildVersion(v1, { name: "one", repo, values: {} }, deps);
      await buildVersion({ flowId: "flow-1", version: 2 }, { name: "two", repo, values: {} }, deps);

      expect(store.listBuilds().map((build) => build.source)).toEqual([
        { flowId: "flow-1", version: 2 },
        { flowId: "flow-1", version: 1 },
      ]);
    });
  });
});

describe("buildResumeOf", () => {
  const session: BuildEvent = {
    type: "session",
    name: "fd-build-1",
    claudeSessionId: "c1",
    buildId: "b1",
    repo: "/repo",
    base: "main",
    values: {},
  };
  const step = (n: 1 | 2 | 3 | 4 | 5, status: "running" | "done", round?: number): BuildEvent => ({
    type: "step",
    step: n,
    status,
    ...(round === undefined ? {} : { round }),
  });
  const laidDown: BuildEvent[] = [
    step(1, "running"),
    step(1, "done"),
    session,
    step(2, "running"),
    step(2, "done"),
  ];

  it("resumes a build left in a step-3 turn, counting the turns sent", () => {
    expect(buildResumeOf([...laidDown, step(3, "running", 2)])).toEqual({
      session,
      round: 2,
      turnsSent: 1,
    });
  });

  it.each<[string, BuildEvent[]]>([
    ["has no session yet", [step(1, "running")]],
    ["is in step 4", [...laidDown, step(3, "running"), step(3, "done"), step(4, "running")]],
    [
      "has applied a merge",
      [
        ...laidDown,
        step(3, "running"),
        { type: "merge", nodeIds: ["a", "b"], piece: "plugin/agents/a.md" },
        step(3, "running"),
      ],
    ],
  ])("does not resume a build that %s", (_, events) => {
    expect(buildResumeOf(events)).toBeUndefined();
  });
});
