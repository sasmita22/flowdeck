import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVersion } from "../../../src/core/compiler/build-version.js";
import type { BuildConfig, Flow } from "../../../src/core/flow/schema.js";
import type { FolderState } from "../../../src/ports/git-state.js";
import type { WorktreeAddOptions } from "../../../src/ports/worktree.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWorktree } from "../../fakes/fake-worktree.js";
import { flow, prompt, script, thenWire } from "../../fixtures/flow-builders.js";

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

const errorMessages = (result: Awaited<ReturnType<typeof buildVersion>>): string[] =>
  result.ok ? [] : result.errors.map((error) => error.message);

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
    return {
      flows,
      store,
      fs,
      gitState,
      worktree,
      deps: { flows, store, fs, gitState, worktree, newId, home },
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
