import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RunNarration, RunNarrator } from "../../ports/run-narrator.js";
import { PARENT_SESSION_VARS } from "./claude-cli.js";

export const narratorPrompt = [
  "Stdin holds the digest of one finished Flowdeck run: the facts of a multi-step job Flowdeck ran for the user.",
  "Write exactly three parts, each starting on its own line with its label, in this order: Context:, Goal:, Result:.",
  "Context: one or two sentences naming the repo and branch, from the Repo and Branch lines, and how things stood before the run.",
  "Goal: one or two sentences on what the job was meant to accomplish, from the Instructions lines, or from the stage labels when there are none.",
  "Result: what was done and how things stand after, from the Report, Steps, Files written and Final reply lines, the Run status line and each stage's status; for a failed or stopped run, where it stopped and what was left undone.",
  "Use only facts from the digest and name stages by their labels. Name any other repo only when the digest shows it.",
  'When the digest does not show how things stood before or after, write "not recorded" instead of guessing.',
  "Plain text: no headings, lists or markdown.",
].join("\n");

const streamLine = z.union([
  z.looseObject({
    type: z.literal("system"),
    subtype: z.literal("init"),
    tools: z.array(z.unknown()),
  }),
  z.looseObject({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    total_cost_usd: z.number().optional(),
  }),
]);

const maxOutput = 16 * 1024 * 1024;

const lineOf = (line: string) => {
  try {
    const parsed = streamLine.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const linesOf = (stdout: string) =>
  stdout.split("\n").flatMap((line) => {
    const parsed = lineOf(line);
    return parsed === undefined ? [] : [parsed];
  });

const toolsError = (tools: unknown) =>
  new Error(`The narrator started with tools: ${JSON.stringify(tools)}`);

function narrationOf(stdout: string): RunNarration {
  const lines = linesOf(stdout);
  const init = lines.find((line) => line.type === "system");
  if (init === undefined || init.tools.length > 0) throw toolsError(init?.tools);
  const result = lines.findLast((line) => line.type === "result");
  if (result?.type !== "result") throw new Error("The narrator gave no result");
  const { is_error, result: text, total_cost_usd: cost, subtype } = result;
  if (is_error || text === undefined || cost === undefined) {
    throw new Error(`The narrator failed: ${subtype} ${text ?? ""}`);
  }
  return { text: text.trim(), cost };
}

export class ClaudeNarrator implements RunNarrator {
  private readonly home: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor({
    home,
    command = "claude",
    timeoutMs = 120_000,
  }: {
    home: string;
    command?: string;
    timeoutMs?: number;
  }) {
    this.home = home;
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  async narrate(digest: string, signal: AbortSignal): Promise<RunNarration> {
    const folder = join(this.home, "narrator");
    const settings = join(folder, "settings.json");
    await mkdir(folder, { recursive: true });
    await writeFile(settings, "{}\n");
    const parentVars = new Set<string>(PARENT_SESSION_VARS);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !parentVars.has(name)),
    );
    const args = [
      "-p",
      narratorPrompt,
      "--model",
      "haiku",
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--settings",
      settings,
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    signal.throwIfAborted();
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: folder, env });
      let out = "";
      let errors = "";
      let unread = "";
      let initSeen = false;
      let failure: unknown;
      const stop = (reason: unknown) => {
        if (failure !== undefined) return;
        failure = reason;
        child.kill("SIGKILL");
      };
      const abort = () => stop(signal.reason);
      const timer = setTimeout(
        () => stop(new Error(`The narrator ran past ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        settle();
      };
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.length > maxOutput) stop(new Error("The narrator printed too much"));
        unread += chunk;
        const complete = unread.split("\n");
        unread = complete.pop() ?? "";
        for (const line of complete) {
          const parsed = initSeen ? undefined : lineOf(line);
          if (parsed?.type !== "system") continue;
          initSeen = true;
          if (parsed.tools.length > 0) stop(toolsError(parsed.tools));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        errors += chunk;
      });
      child.on("error", (error) => {
        finish(() => reject(failure ?? error));
      });
      child.on("close", (code, killedBy) => {
        finish(() => {
          if (failure !== undefined) reject(failure);
          else if (code === 0) resolve(out);
          else {
            reject(new Error(`The narrator exited with ${code ?? killedBy}: ${errors.trim()}`));
          }
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(digest);
    });
    return narrationOf(stdout);
  }
}
