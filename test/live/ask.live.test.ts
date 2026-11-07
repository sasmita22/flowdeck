import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { parseFlow } from "../../src/core/flow/schema.js";
import { FakeWaiter } from "../fakes/fake-waiter.js";
import { liveEngine, type LiveEngine } from "../fixtures/live-engine.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const buildName = "live-ask";
const runTimeoutMs = 300_000;
const colourWord = /\b(red|blue|green)\b/i;
const promptText =
  "Write a file colour.md whose only content is the colour the user answered, or NONE if no colour is named.";

const hasCode = (error: unknown, ...codes: (string | number)[]) =>
  error instanceof Error && "code" in error && codes.includes(error.code as string | number);

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow() {
  return parseFlow({
    nodes: [
      {
        id: "t",
        label: "Start",
        type: "trigger",
        position: at(0),
        settings: {},
      },
      {
        id: "q1",
        label: "Pick",
        type: "ask",
        position: at(1),
        settings: { question: "Pick a colour", options: ["red", "blue", "green"] },
      },
      {
        id: "p1",
        label: "Write",
        type: "prompt",
        position: at(2),
        settings: { instructions: promptText },
      },
      {
        id: "o",
        label: "Done",
        type: "output",
        position: at(3),
        settings: { name: "result", type: "text" },
      },
    ],
    wires: [then("t", "q1"), then("q1", "p1"), then("p1", "o")],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [] },
      model: "haiku",
      allowedTools: [],
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

async function readOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("ask nodes with real claude", () => {
  const sessionName = `fd-live-ask-${process.pid}`;
  let home: string;
  let repo: TmpRepo;
  let engine: LiveEngine | undefined;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-home-")));
    repo = await createTmpRepo({ commit: true });
    engine = undefined;
  });

  afterEach(async () => {
    await engine?.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "attaches the Ask's answer to the next Prompt, which writes it to colour.md",
    { timeout: runTimeoutMs },
    async () => {
      engine = liveEngine({
        home,
        repo: repo.path,
        sessionName,
        waiter: new FakeWaiter([{ decision: "answer", answer: "blue" }]),
      });

      const flow = liveFlow();
      const built = await engine.saveAndBuild(flow, { name: buildName });
      const colourPath = join(built.workFolder, "colour.md");
      expect(await readOrMissing(colourPath)).toBeUndefined();
      expect(promptText).not.toMatch(colourWord);
      expect(
        await readFile(
          join(built.dir, "plugin", "skills", pieceNames(flow).get("p1") ?? "", "SKILL.md"),
          "utf8",
        ),
      ).not.toMatch(colourWord);

      const runId = await engine.runBuild(built.buildId);
      const status = await engine.waitForRunEnd(runId, runTimeoutMs - 60_000);

      const events = engine.stores.runs.events(runId);
      const progress = events.flatMap((event) => {
        if (event.nodeId === "q1" && event.kind === "answered") {
          return [
            `q1 answered: ${event.payload.decision === "answered" ? event.payload.answer : event.payload.decision}`,
          ];
        }
        if (event.nodeId === "p1" && event.kind === "sent") return ["p1 started"];
        if (event.nodeId === "p1" && event.kind === "done") return ["p1 done"];
        return [];
      });
      const colour = await readOrMissing(colourPath);
      console.log(
        [
          `hash: ${built.hash}`,
          `status: ${status}`,
          `progress:\n${progress.join("\n")}`,
          `colour.md: ${JSON.stringify(colour)}`,
        ].join("\n"),
      );

      expect.soft(status).toBe("done");
      expect.soft(progress).toEqual(["q1 answered: blue", "p1 started", "p1 done"]);
      expect.soft(colour, "colour.md exists").toBeDefined();
      const content = (colour ?? "").trim().toLowerCase();
      expect.soft(content, "colour.md names the answer").toContain("blue");
      expect.soft(content, "colour.md is not NONE").not.toBe("none");
    },
  );
});
