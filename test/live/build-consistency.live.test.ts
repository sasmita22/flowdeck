import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareKit } from "../../src/adapters/node-fs/kit-copy.js";
import { buildReportSchema, type BuildReport } from "../../src/core/compiler/build-report.js";
import type { BuildCheckFailure } from "../../src/core/compiler/check-build.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";
import { liveEngine, realBuildAgents } from "../fixtures/live-engine.js";
import { checkRecorded, recording, type Workspace } from "../fixtures/recorded-build.js";
import { createTmpRepo } from "../fixtures/tmp-repo.js";

const kitSourceDir = fileURLToPath(new URL("../../kit", import.meta.url));
const examplePath = fileURLToPath(new URL("../../examples/three-agents.json", import.meta.url));
const buildTimeoutMs = 900_000;
const builds = 3;

type Outcome = {
  outcome: string;
  report: BuildReport;
  failures: BuildCheckFailure[];
  pieces: string[];
  merges: string[];
};

async function buildOnce(flow: Flow, index: number): Promise<Outcome> {
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
    const built = await engine.saveAndEndBuild(flow, {
      name: "consistency",
      values: { ticket: "Add a farewell function" },
      buildModel: "haiku",
    });
    const report = buildReportSchema.parse(built.outcome.report);
    const { failures } = checkRecorded(workspace, report, flow);
    const outcome: Outcome = {
      outcome: built.outcome.outcome,
      report,
      failures,
      pieces: report.pieces.map((piece) => `${piece.path} ${piece.status}`).sort(),
      merges: report.merges.map((merge) => [...merge.nodeIds].sort().join("+")).sort(),
    };
    console.log(`build ${index}: ${JSON.stringify(outcome, null, 2)}`);
    return outcome;
  } finally {
    await engine.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("builds of one blueprint", () => {
  it(
    "give the same pieces and merges three times, every piece passing the build check",
    { timeout: builds * (buildTimeoutMs + 120_000) },
    async () => {
      const flow = parseFlow(JSON.parse(await readFile(examplePath, "utf8")));
      const outcomes: Outcome[] = [];
      for (let index = 1; index <= builds; index++) outcomes.push(await buildOnce(flow, index));

      for (const outcome of outcomes) {
        expect(outcome.outcome).toBe("built");
        expect(outcome.failures).toEqual([]);
        expect(outcome.pieces).not.toEqual([]);
      }
      const [first, ...rest] = outcomes;
      for (const outcome of rest) {
        expect(outcome.pieces).toEqual(first?.pieces);
        expect(outcome.merges).toEqual(first?.merges);
      }
    },
  );
});
