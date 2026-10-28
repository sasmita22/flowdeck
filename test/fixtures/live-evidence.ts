import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export class WatchdogError extends Error {
  constructor(ms: number) {
    super(`watchdog: no result within ${ms} ms`);
    this.name = "WatchdogError";
  }
}

export function withWatchdog<T>(
  work: Promise<T>,
  ms: number,
  onExpiry: () => Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onExpiry().finally(() => reject(new WatchdogError(ms)));
    }, ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export async function paneText(socket: string, session: string): Promise<string> {
  try {
    const { stdout } = await run("tmux", [
      "-L",
      socket,
      "capture-pane",
      "-p",
      "-t",
      `=${session}:`,
    ]);
    return stdout;
  } catch (error) {
    return `no pane: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };

const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

const blockText = (block: Block): string => {
  if (block.type === "text") return `text: ${block.text ?? ""}`;
  if (block.type === "tool_use")
    return `tool_use ${block.name ?? ""} ${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") {
    const content =
      typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    return `tool_result: ${content}`;
  }
  return block.type ?? "unknown";
};

export async function transcriptTail(path: string, count = 40): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return [`no transcript: ${error instanceof Error ? error.message : String(error)}`];
  }
  const lines = raw.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    let entry: { message?: { role?: string; content?: string | Block[] } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      return [];
    }
    const message = entry.message;
    if (message?.role === undefined || message.content === undefined) return [];
    const blocks =
      typeof message.content === "string"
        ? [`text: ${message.content}`]
        : message.content.map(blockText);
    return blocks.map((text) => clip(`${message.role}: ${text}`.replace(/\s+/g, " ")));
  });
  return lines.slice(-count);
}
