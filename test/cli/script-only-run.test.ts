import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../src/adapters/process/process-runner.js";
import { runCli, type CliDeps } from "../../src/cli/main.js";
import { build } from "../../src/core/compiler/build.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { flow, script, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

describe("a script-only run", () => {
  let home: string;
  let repo: TmpRepo;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it("runs the scripts in the repo and never starts Claude", async () => {
    const fs = new NodeFileSystem();
    const result = await build(
      flow(
        [
          script("write", {
            settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
          }),
          script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
        ],
        [thenWire("write", "check")],
      ),
      { fs, home, hooks: { nodePath: process.execPath, hookScriptPath: "/h" } },
    );
    if (!result.ok) throw new Error("build failed");
    let openSessionCalls = 0;
    let eventStops = 0;
    const lines: string[] = [];
    const deps: CliDeps = {
      env: { FLOWDECK_HOME: home },
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      fs,
      scripts: new NodeProcessRunner(),
      waiter: new FakeWaiter([]),
      startEvents: async () => ({
        events: new FakeEventSource(),
        stop: async () => {
          eventStops++;
        },
      }),
      openSession: async () => {
        openSessionCalls++;
        throw new Error("Claude must not start for a script-only flow");
      },
    };

    expect(await runCli(["run", result.dir, "--cwd", repo.path], deps)).toBe(0);
    expect(await readFile(join(repo.path, "side-effect.txt"), "utf8")).toBe("ran\n");
    expect(openSessionCalls).toBe(0);
    expect(eventStops).toBe(1);
    expect(lines).toEqual(["write started", "write done", "check started", "check done"]);
  });
});
