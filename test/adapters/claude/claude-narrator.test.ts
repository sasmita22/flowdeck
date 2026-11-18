import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARENT_SESSION_VARS } from "../../../src/adapters/claude/claude-cli.js";
import { ClaudeNarrator, narratorPrompt } from "../../../src/adapters/claude/claude-narrator.js";

let folder: string;
let home: string;

type Seen = { argv: string[]; stdin: string; cwd: string; env: Record<string, string> };

const init = (tools: string[]) => JSON.stringify({ type: "system", subtype: "init", tools });

const result = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

async function standIn(lines: string[], { exit = 0 }: { exit?: number } = {}): Promise<string> {
  const path = join(folder, "claude");
  const seen = join(folder, "seen.json");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: process.env,
  }));
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");
  process.exit(${exit});
});
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function hangingStandIn(): Promise<{ command: string; pid: () => Promise<number> }> {
  const path = join(folder, "claude");
  const pidFile = join(folder, "pid");
  await writeFile(
    path,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {}, 60000);
`,
  );
  await chmod(path, 0o755);
  return {
    command: path,
    pid: () =>
      vi.waitFor(async () => Number(await readFile(pidFile, "utf8")), {
        timeout: 5000,
        interval: 20,
      }),
  };
}

async function initThenHang(
  tools: string[],
): Promise<{ command: string; pid: () => Promise<number> }> {
  const path = join(folder, "claude");
  const pidFile = join(folder, "pid");
  await writeFile(
    path,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write(${JSON.stringify(init(tools))} + "\\n");
setTimeout(() => {}, 60000);
`,
  );
  await chmod(path, 0o755);
  return {
    command: path,
    pid: () =>
      vi.waitFor(async () => Number(await readFile(pidFile, "utf8")), {
        timeout: 5000,
        interval: 20,
      }),
  };
}

const seen = async (): Promise<Seen> =>
  JSON.parse(await readFile(join(folder, "seen.json"), "utf8")) as Seen;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = () => new AbortController().signal;

describe("ClaudeNarrator", () => {
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-narrator-"));
    home = join(folder, "home");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(folder, { recursive: true, force: true });
  });

  it("runs claude -p headless with the fixed isolation flags, the digest on stdin, in the narrator folder", async () => {
    const command = await standIn([init([]), result({ result: "Story.", total_cost_usd: 0.003 })]);

    await new ClaudeNarrator({ home, command }).narrate("the digest text", signal());

    const { argv, stdin, cwd } = await seen();
    expect(argv[0]).toBe("-p");
    expect(typeof argv[1]).toBe("string");
    expect(argv[1]?.trim()).not.toBe("");
    expect(argv[1]).toBe(narratorPrompt);
    expect(argv.slice(2)).toEqual([
      "--model",
      "haiku",
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--settings",
      argv[10],
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(stdin).toBe("the digest text");
    const narratorFolder = await realpath(join(home, "narrator"));
    expect(await realpath(cwd)).toBe(narratorFolder);
    const settings = resolve(cwd, argv[10] ?? "");
    expect(await realpath(settings)).toBe(join(narratorFolder, "settings.json"));
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({});
  });

  it("leaves the parent Claude session's variables out of the child env and keeps the rest", async () => {
    for (const name of PARENT_SESSION_VARS) vi.stubEnv(name, "from-parent");
    vi.stubEnv("FD_NARRATOR_PROBE", "kept");
    const command = await standIn([init([]), result({ result: "Story.", total_cost_usd: 0 })]);

    await new ClaudeNarrator({ home, command }).narrate("digest", signal());

    const { env } = await seen();
    for (const name of PARENT_SESSION_VARS) expect(env[name]).toBeUndefined();
    expect(env.FD_NARRATOR_PROBE).toBe("kept");
  });

  it("resolves the result text and the CLI's own cost", async () => {
    const command = await standIn([
      init([]),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      result({ result: "Verify failed.\nThe tests broke.", total_cost_usd: 0.0042 }),
    ]);

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).resolves.toEqual({ text: "Verify failed.\nThe tests broke.", cost: 0.0042 });
  });

  it("rejects when the session started with tools", async () => {
    const command = await standIn([
      init(["Bash", "Read"]),
      result({ result: "Story.", total_cost_usd: 0.001 }),
    ]);

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).rejects.toThrow();
  });

  it("kills a session the moment its init line lists tools, long before the timeout", async () => {
    const { command, pid } = await initThenHang(["Bash"]);
    const narrator = new ClaudeNarrator({ home, command, timeoutMs: 30_000 });
    const started = Date.now();

    const refused = expect(narrator.narrate("digest", signal())).rejects.toThrow(/tools/);
    const child = await pid();

    await refused;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(child)).toBe(false);
  });

  it("rejects an error result", async () => {
    const command = await standIn([
      init([]),
      result({
        is_error: true,
        subtype: "error_during_execution",
        result: "boom",
        total_cost_usd: 0,
      }),
    ]);

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).rejects.toThrow();
  });

  it("rejects a non-zero exit even after a result line", async () => {
    const command = await standIn([init([]), result({ result: "Story.", total_cost_usd: 0 })], {
      exit: 1,
    });

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).rejects.toThrow();
  });

  it("rejects when no result line arrives", async () => {
    const command = await standIn([init([])]);

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).rejects.toThrow();
  });

  it("rejects and kills the child when it runs past the timeout", async () => {
    const { command, pid } = await hangingStandIn();
    const narrator = new ClaudeNarrator({ home, command, timeoutMs: 1000 });

    const pending = narrator.narrate("digest", signal());
    const child = await pid();

    await expect(pending).rejects.toThrow();
    expect(alive(child)).toBe(false);
  });

  it("skips stream lines that are not JSON or not a line it knows, and still reads the result", async () => {
    const command = await standIn([
      "not json at all",
      init([]),
      '{"type":"result","subtype":"succ',
      JSON.stringify({ type: "result", subtype: "success" }),
      result({ result: "Story.", total_cost_usd: 0.002 }),
    ]);

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", signal()),
    ).resolves.toEqual({ text: "Story.", cost: 0.002 });
  });

  it("rejects a result when no init line showed the session had no tools", async () => {
    const command = await standIn([result({ result: "Story.", total_cost_usd: 0.001 })]);

    await expect(new ClaudeNarrator({ home, command }).narrate("digest", signal())).rejects.toThrow(
      /tools/,
    );
  });

  it.each([
    ["no text", { subtype: "error_max_turns", total_cost_usd: 0.001 }],
    ["no cost", { result: "Story." }],
  ])("rejects a result not flagged as an error that has %s", async (_, fields) => {
    const command = await standIn([init([]), result(fields)]);

    await expect(new ClaudeNarrator({ home, command }).narrate("digest", signal())).rejects.toThrow(
      /failed/,
    );
  });

  it("rejects and kills the child once it prints more than the output cap", async () => {
    const path = join(folder, "claude");
    const pidFile = join(folder, "pid");
    await writeFile(
      path,
      `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("x".repeat(17 * 1024 * 1024));
setTimeout(() => {}, 60000);
`,
    );
    await chmod(path, 0o755);
    const narrator = new ClaudeNarrator({ home, command: path, timeoutMs: 30_000 });

    const pending = narrator.narrate("digest", signal());
    const child = await vi.waitFor(async () => Number(await readFile(pidFile, "utf8")), {
      timeout: 5000,
      interval: 20,
    });

    await expect(pending).rejects.toThrow(/too much/);
    expect(alive(child)).toBe(false);
  });

  it("rejects a signal already aborted without starting the command", async () => {
    const command = await standIn([init([]), result({ result: "Story.", total_cost_usd: 0 })]);
    const controller = new AbortController();
    controller.abort(new Error("closing"));

    await expect(
      new ClaudeNarrator({ home, command }).narrate("digest", controller.signal),
    ).rejects.toThrow("closing");
    await expect(seen()).rejects.toThrow();
  });

  it("rejects when the command cannot be started", async () => {
    const command = join(folder, "no-such-claude");

    await expect(new ClaudeNarrator({ home, command }).narrate("digest", signal())).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("rejects and kills the child when the signal aborts", async () => {
    const { command, pid } = await hangingStandIn();
    const controller = new AbortController();

    const pending = new ClaudeNarrator({ home, command }).narrate("digest", controller.signal);
    const child = await pid();
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(alive(child)).toBe(false);
  });
});

const promptLinesAbout = (label: string) =>
  narratorPrompt
    .split("\n")
    .filter((line) => line.includes(label))
    .join("\n");

describe("narratorPrompt", () => {
  it("asks for three parts, each on its own line, labelled Context:, Goal: and Result: in that order", () => {
    const context = narratorPrompt.indexOf("Context:");
    const goal = narratorPrompt.indexOf("Goal:");
    const result = narratorPrompt.indexOf("Result:");

    expect(context).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThan(context);
    expect(result).toBeGreaterThan(goal);
    expect(narratorPrompt).toMatch(/three/i);
    expect(narratorPrompt).toMatch(/own line/i);
  });

  it("has Context name the repo, the branch and how things stood before, as recorded", () => {
    const context = promptLinesAbout("Context");

    expect(context).toMatch(/repo/i);
    expect(context).toMatch(/branch/i);
    expect(context).toMatch(/before/i);
  });

  it("has Goal say what the job was meant to accomplish, from the instructions", () => {
    expect(promptLinesAbout("Goal")).toMatch(/instructions/i);
  });

  it("has Result say what was done and how it stands after, and for a failed or stopped run where it stopped and what was left undone", () => {
    const result = promptLinesAbout("Result");

    expect(result).toMatch(/after/i);
    expect(result).toMatch(/fail/i);
    expect(result).toMatch(/stopped/i);
    expect(result).toMatch(/undone|not done|unfinished/i);
  });

  it("keeps to digest facts, names other repos only when recorded, and says plainly when a before or after state was not recorded", () => {
    expect(narratorPrompt).toMatch(/only facts from the digest|only digest facts/i);
    expect(narratorPrompt).toMatch(/other repo/i);
    expect(narratorPrompt).toMatch(/not recorded/i);
  });

  it("has Context state the Before: line and Result state the After: line", () => {
    expect(promptLinesAbout("Context:")).toContain("Before:");
    expect(promptLinesAbout("Result:")).toContain("After:");
  });

  it("names another repo only when an Other repos: line shows it", () => {
    expect(promptLinesAbout("other repo")).toContain("Other repos:");
  });

  it("no longer promises a first line shown alone in the list of runs", () => {
    expect(narratorPrompt).not.toMatch(/shown alone/i);
    expect(narratorPrompt).not.toMatch(/list of runs/i);
  });
});
