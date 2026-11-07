import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import { createEngineHandler } from "../../../src/app/engine/engine-handler.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeGitState } from "../../fakes/fake-git-state.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { fakeEngineBuildOptions } from "../../fixtures/fake-build-deps.js";
import { flow, script, thenWire } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

describe("a script-only run started from a saved blueprint", () => {
  let home: string;
  let repo: TmpRepo;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo({ commit: true });
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it("runs the scripts in the build's worktree, not the target repo, and never starts Claude", async () => {
    const fs = new NodeFileSystem();
    const runs = new FakeStore();
    const flows = new FakeFlowStore();
    let openSessionCalls = 0;
    const handler = createEngineHandler({
      version: "test",
      openStores: () => ({ runs, flows }),
      home,
      publish: () => undefined,
      prepareHooks: () => ({
        kind: "ok",
        nodePath: process.execPath,
        hookScriptPath: `${home}/hooks/flowdeck-hook.cjs`,
        guardScriptPath: `${home}/hooks/flowdeck-build-guard.cjs`,
      }),
      ...fakeEngineBuildOptions(fs),
      isFolder: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
      fs,
      connectors: new FakeConnectorSource(),
      run: {
        fs,
        now: Date.now,
        scripts: new NodeProcessRunner(),
        waiter: new FakeWaiter([]),
        startEvents: async () => ({ events: new FakeEventSource(), stop: async () => undefined }),
        openSession: async () => {
          openSessionCalls++;
          throw new Error("Claude must not start for a script-only flow");
        },
      },
      worktree: new GitWorktree(),
      gitState: new FakeGitState({ [repo.path]: { kind: "branch", name: "main" } }),
      transcriptTurns: async () => [],
    });
    const blueprint = flow(
      [
        script("write", {
          settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
        }),
        script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
      ],
      [thenWire("write", "check")],
    );
    const saved = flows.save({
      ...blueprint,
      session: { ...blueprint.session, buildConfig: { repo: repo.path, variables: [] } },
    });

    expect(
      await handler.handle({
        id: 1,
        type: "build-version",
        payload: { ...saved, name: "x", values: {} },
      }),
    ).toMatchObject({ ok: true, value: { kind: "started" } });
    await vi.waitFor(() => expect(runs.listPendingBuilds()).toEqual([]), { timeout: 5000 });
    const built = runs.findBuildByName("x");
    if (built === undefined) throw new Error("the build was not recorded");
    const { id, dir } = built;
    const started = await handler.handle({ id: 2, type: "run-build", payload: { buildId: id } });
    expect(started).toMatchObject({ ok: true, value: { kind: "started" } });
    const { runId } = (started as { value: { runId: string } }).value;
    await vi.waitFor(() => expect(runs.findRun(runId)?.status).not.toBe("running"), {
      timeout: 5000,
    });
    await handler.stop();

    expect(runs.findRun(runId)?.status).toBe("done");
    const workFolder = join(dir, basename(repo.path));
    await expect(readFile(join(workFolder, "side-effect.txt"), "utf8")).resolves.toBe("ran\n");
    await expect(stat(join(repo.path, "side-effect.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(openSessionCalls).toBe(0);
  });
});
