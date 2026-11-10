import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareKit } from "../../src/adapters/node-fs/kit-copy.js";
import { buildReportSchema, type BuildReport } from "../../src/core/compiler/build-report.js";
import { sharedPath } from "../../src/core/compiler/shared.js";
import type { Flow } from "../../src/core/flow/schema.js";
import { agent, onMainFlow, thenWire } from "../fixtures/flow-builders.js";
import { liveEngine, realBuildAgents } from "../fixtures/live-engine.js";
import {
  checkRecorded,
  recording,
  type CheckedBuild,
  type Workspace,
} from "../fixtures/recorded-build.js";
import { createTmpRepo } from "../fixtures/tmp-repo.js";

const kitSourceDir = fileURLToPath(new URL("../../kit", import.meta.url));
const buildTimeoutMs = 900_000;
const tools = ["Bash", "Read", "Edit"];
const runTests = "Run the tests and report the failures.";

type Built = CheckedBuild & { outcome: string; report: BuildReport; files: Map<string, string> };

const threeAgents = (jobs: Record<string, string>): Flow => {
  const ids = Object.keys(jobs);
  const blueprint = onMainFlow(
    ids.map((id) =>
      agent(id, { settings: { role: "", instructions: jobs[id], model: "haiku", tools } }),
    ),
    ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id)),
  );
  return { ...blueprint, session: { ...blueprint.session, allowedTools: [...tools, "Skill"] } };
};

async function build(flow: Flow, name: string): Promise<Built> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
  const repo = await createTmpRepo({ commit: true });
  const workspace: Workspace = { laidDown: undefined, readBack: undefined };
  const kit = prepareKit({ sourceDir: kitSourceDir, home });
  const engine = liveEngine({
    home,
    repo: repo.path,
    buildAgents: recording(realBuildAgents(home), workspace),
    kit: () => kit,
    buildTimeoutMs: buildTimeoutMs - 60_000,
  });
  try {
    const built = await engine.saveAndEndBuild(flow, { name, buildModel: "haiku" });
    const report = buildReportSchema.parse(built.outcome.report);
    const checked = checkRecorded(workspace, report, flow);
    const files = new Map(checked.readBack.map((file) => [file.path, file.content]));
    console.log(
      `build ${name}: ${JSON.stringify(
        { outcome: built.outcome.outcome, report, failures: checked.failures },
        null,
        2,
      )}`,
    );
    for (const [path, content] of files) {
      if (path.startsWith("plugin/")) console.log(`--- ${path}\n${content}`);
    }
    return { ...checked, outcome: built.outcome.outcome, report, files };
  } finally {
    await engine.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
}

const timeout = { timeout: buildTimeoutMs + 120_000 };

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("a build's shared pieces", () => {
  it("are one piece run by all three agents that each run the tests", timeout, async () => {
    const name = "shared-a";
    const built = await build(
      threeAgents({
        build: `Write a slugify(text) function in src/slugify.js. ${runTests}`,
        lint: `List the unused variables in the files under src/. ${runTests}`,
        docs: `Write a docs/usage.md page that shows how to call slugify. ${runTests}`,
      }),
      name,
    );

    expect(built.outcome).toBe("built");
    expect(built.failures).toEqual([]);
    expect(built.report.shared).toHaveLength(1);
    const [entry] = built.report.shared;
    if (entry === undefined) throw new Error("no shared piece");
    expect([...entry.usedBy].sort()).toEqual(["build", "docs", "lint"]);
    expect(built.files.get(sharedPath(entry))?.trim()).toBeTruthy();
    for (const id of ["build", "lint", "docs"]) {
      const agentFile = built.files.get(`plugin/agents/${id}.md`) ?? "";
      expect(agentFile).toContain(`${name}:${entry.name}`);
      expect(agentFile).toMatch(/^tools:.*\bSkill\b/m);
    }
  });

  it("are none when the three agents share no work", timeout, async () => {
    const built = await build(
      threeAgents({
        summary: "Summarise the README in three lines.",
        todos: "List the TODO comments in the source files.",
        count: "Count the source files.",
      }),
      "shared-b",
    );

    expect(built.outcome).toBe("built");
    expect(built.failures).toEqual([]);
    expect(built.report.shared).toEqual([]);
  });
});
