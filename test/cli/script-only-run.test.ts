import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitFolderState } from "../../src/adapters/git/git-state.js";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { buildVersion } from "../../src/core/compiler/build-version.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeConnectorSource } from "../fakes/fake-connector-source.js";
import { FakeFlowStore } from "../fakes/fake-flow-store.js";
import { FakeStore } from "../fakes/fake-store.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { flow, script, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

describe("a script-only run", () => {
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
    const store = new FakeStore();
    const flows = new FakeFlowStore();
    const gitState = new GitFolderState();
    const worktree = new GitWorktree();
    const newId = () => "0f3a9c2e-0000-4000-8000-000000000000";
    const result = await buildVersion(
      flows.save(
        flow(
          [
            script("write", {
              settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
            }),
            script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
          ],
          [thenWire("write", "check")],
        ),
      ),
      { name: "x", repo: repo.path, values: {} },
      { flows, store, fs, home, gitState, worktree, newId },
    );
    if (!result.ok) throw new Error(`build failed: ${JSON.stringify(result.errors)}`);
    let openSessionCalls = 0;
    let eventStops = 0;
    const lines: string[] = [];
    const errors: string[] = [];
    const deps: CliDeps = {
      env: { FLOWDECK_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
      fs,
      scripts: new NodeProcessRunner(),
      waiter: new FakeWaiter([]),
      gitState,
      worktree,
      newId,
      startEvents: async () => ({
        events: new FakeEventSource(),
        stop: async () => {
          eventStops++;
        },
      }),
      openStore: () => ({ runs: store, flows }),
      hooks: { nodePath: process.execPath, hookScriptPath: "/h" },
      connectors: new FakeConnectorSource(),
      transcriptTurns: async () => [],
      openSession: async () => {
        openSessionCalls++;
        throw new Error("Claude must not start for a script-only flow");
      },
    };

    expect(await runCli(["run", "x"], deps)).toBe(0);
    const workFolder = join(result.dir, basename(repo.path));
    expect(await readFile(join(workFolder, "side-effect.txt"), "utf8")).toBe("ran\n");
    await expect(stat(join(repo.path, "side-effect.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(openSessionCalls).toBe(0);
    expect(eventStops).toBe(1);
    expect(lines).toEqual(["write started", "write done", "check started", "check done"]);
    expect(errors).toEqual(["run run-1"]);
  });
});
