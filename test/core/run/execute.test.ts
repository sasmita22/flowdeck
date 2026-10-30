import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node-fs/node-file-system.js";
import { NodeProcessRunner } from "../../../src/adapters/process/process-runner.js";
import { build } from "../../../src/core/compiler/build.js";
import type { Manifest } from "../../../src/core/compiler/lower.js";
import {
  execute,
  loadBuild,
  needsClaude,
  noClaude,
  runSocketPath,
} from "../../../src/core/run/execute.js";
import type { ScriptResult } from "../../../src/core/run/runner.js";
import { FakeEventSource } from "../../fakes/fake-event-source.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { FakeWaiter } from "../../fakes/fake-waiter.js";
import { flow, script, thenWire } from "../../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const fs = new NodeFileSystem();

const scriptOnly = () =>
  flow(
    [
      script("write", {
        settings: { command: "sh", args: ["-c", "echo ran > side-effect.txt"] },
      }),
      script("check", { settings: { command: "test", args: ["-f", "side-effect.txt"] } }),
    ],
    [thenWire("write", "check")],
  );

const manifestWith = (types: string[]) =>
  ({
    nodes: types.map((type, index) => ({ id: `n${index}`, type })),
  }) as unknown as Manifest & { hash: string };

describe("the core run path", () => {
  let home: string;
  let repo: TmpRepo;
  let dir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fd-home-"));
    repo = await createTmpRepo();
    const result = await build(scriptOnly(), {
      fs,
      home,
      hooks: { nodePath: process.execPath, hookScriptPath: "/h" },
    });
    if (!result.ok) throw new Error("build failed");
    dir = result.dir;
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  const loaded = async () => {
    const result = await loadBuild(dir, { fs });
    if (result.kind !== "loaded") throw new Error(`build not loaded: ${result.message}`);
    return result.build;
  };

  const startEvents = () => {
    let stops = 0;
    return {
      stops: () => stops,
      startEvents: async () => ({
        events: new FakeEventSource(),
        stop: async () => {
          stops++;
        },
      }),
    };
  };

  describe("loadBuild", () => {
    it("loads a verified build with its manifest", async () => {
      const result = await loadBuild(dir, { fs });

      expect(result.kind).toBe("loaded");
      if (result.kind !== "loaded") return;
      expect(result.build.nodes.map((node) => node.id)).toEqual(["write", "check"]);
      expect(result.build.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses a build with a changed file, with the message the CLI prints", async () => {
      const files = (await fs.list(dir)).filter((path) => path !== "manifest.json");
      const changed = files[0];
      if (changed === undefined) throw new Error("the build has no file besides its manifest");
      await writeFile(join(dir, changed), "tampered\n");

      expect(await loadBuild(dir, { fs })).toEqual({
        kind: "error",
        message: `${changed}: changed`,
      });
    });

    it("refuses a missing build folder", async () => {
      const result = await loadBuild(join(home, "builds", "nope"), { fs });

      expect(result.kind).toBe("error");
    });
  });

  describe("execute", () => {
    it("runs a script-only build in the repo and records it done", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      const lines: string[] = [];
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      });

      const code = await execute(
        {
          fs,
          scripts: new NodeProcessRunner(),
          waiter: new FakeWaiter([]),
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a script-only flow");
          },
          store,
          onChange: (line: string) => lines.push(line),
        },
        {
          store,
          runId: id,
          manifest: build,
          cwd: repo.path,
          auto: false,
          socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
          open: async () => noClaude,
        },
      );

      expect(code).toBe(0);
      expect(await readFile(join(repo.path, "side-effect.txt"), "utf8")).toBe("ran\n");
      expect(lines).toEqual(["write started", "write done", "check started", "check done"]);
      expect(events.stops()).toBe(1);
      expect(store.runs[0]?.status).toBe("done");
    });

    it("records the run stopped when interrupted while a script runs", async () => {
      const build = await loaded();
      const store = new FakeStore();
      const events = startEvents();
      let interrupt: (code: number) => void = () => undefined;
      let release: (result: ScriptResult) => void = () => undefined;
      const blocked = new Promise<ScriptResult>((resolve) => (release = resolve));
      const { id } = store.createRun({
        buildDir: dir,
        inputs: {},
        nodeIds: build.nodes.map((node) => node.id),
        session: { tmuxName: "fd-run-abcd1234", cwd: repo.path, claudeSessionId: "c1" },
      });

      const code = await execute(
        {
          fs,
          scripts: {
            run: () => {
              interrupt(130);
              return blocked;
            },
          },
          waiter: new FakeWaiter([]),
          startEvents: events.startEvents,
          openSession: async () => {
            throw new Error("Claude must not start for a script-only flow");
          },
          store,
          onChange: () => undefined,
          onInterrupt: (handler: (exitCode: number) => void) => {
            interrupt = handler;
            return () => undefined;
          },
        },
        {
          store,
          runId: id,
          manifest: build,
          cwd: repo.path,
          auto: false,
          socketPath: join(home, "sockets", "fd-run-abcd1234.sock"),
          open: async () => noClaude,
        },
      );
      release({ code: 0, stdout: "", stderr: "" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(code).toBe(130);
      expect(store.runs[0]?.status).toBe("stopped");
    });
  });

  describe("needsClaude", () => {
    it("is true for a manifest with a prompt node", () => {
      expect(needsClaude(manifestWith(["script", "prompt"]))).toBe(true);
    });

    it("is false for scripts only", () => {
      expect(needsClaude(manifestWith(["script", "script"]))).toBe(false);
    });
  });

  describe("runSocketPath", () => {
    it("puts the socket under the home's sockets folder", () => {
      expect(runSocketPath(home, "fd-run-abcd1234")).toEqual({
        kind: "ok",
        path: `${home}/sockets/fd-run-abcd1234.sock`,
      });
    });

    it("refuses a path longer than 104 characters with the CLI's message", () => {
      const longHome = `/${"h".repeat(120)}`;

      expect(runSocketPath(longHome, "fd-run-abcd1234")).toEqual({
        kind: "error",
        message: `Socket path "${longHome}/sockets/fd-run-abcd1234.sock" is longer than 104 characters`,
      });
    });
  });
});
