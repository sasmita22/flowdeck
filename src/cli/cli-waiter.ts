import type { Readable } from "node:stream";
import type { WaitReply, WaitRequest, Waiter } from "../ports/waiter.js";

export type CliWaiterIo = {
  readLine: () => Promise<string | null>;
  write: (text: string) => void;
};

type Question = { header: string; prompt: string; parse: (line: string) => WaitReply | undefined };

const withReason = (line: string, word: string): string | undefined => {
  if (line === word) return "";
  if (line.startsWith(`${word} `)) return line.slice(word.length).trim();
  return undefined;
};

function gateQuestion(nodeId: string, shown: string): Question {
  return {
    header: `${nodeId} gate: ${shown}\n`,
    prompt: "approve, or reject <reason>: ",
    parse: (line) => {
      if (line === "approve") return { decision: "approve" };
      const reason = withReason(line, "reject");
      return reason === undefined ? undefined : { decision: "reject", reason };
    },
  };
}

function hardstopQuestion(nodeId: string, shown: string, condition: string): Question {
  return {
    header: `${nodeId} hard stop: ${shown}\ncondition: ${condition}\n`,
    prompt: "continue, or stop <reason>: ",
    parse: (line) => {
      if (line === "continue") return { decision: "continue" };
      const reason = withReason(line, "stop");
      return reason === undefined ? undefined : { decision: "stop", reason };
    },
  };
}

function askQuestion(nodeId: string, question: string, options: readonly string[]): Question {
  const header = `${nodeId} asks: ${question}\n`;
  if (options.length === 0) {
    return {
      header,
      prompt: "answer: ",
      parse: (line) => (line === "" ? undefined : { decision: "answer", answer: line }),
    };
  }
  return {
    header: header + options.map((option, i) => `  ${i + 1}. ${option}\n`).join(""),
    prompt: "answer (number or label): ",
    parse: (line) => {
      const picked = /^\d+$/.test(line)
        ? options[Number(line) - 1]
        : options.find((o) => o === line);
      return picked === undefined ? undefined : { decision: "answer", answer: picked };
    },
  };
}

function questionFor(request: WaitRequest): Question {
  switch (request.kind) {
    case "gate":
      return gateQuestion(request.nodeId, request.shown);
    case "hardstop":
      return hardstopQuestion(request.nodeId, request.shown, request.condition);
    case "ask":
      return askQuestion(request.nodeId, request.question, request.options);
  }
}

export class CliWaiter implements Waiter {
  constructor(private readonly io: CliWaiterIo) {}

  async wait(request: WaitRequest): Promise<WaitReply> {
    const { header, prompt, parse } = questionFor(request);
    this.io.write(header + prompt);
    for (;;) {
      const read = await this.io.readLine();
      if (read === null) return { decision: "closed" };
      const line = read.trim();
      const reply = parse(line);
      if (reply !== undefined) return reply;
      this.io.write(`not understood: ${line}\n${prompt}`);
    }
  }
}

export function stdinLines(input: Readable): () => Promise<string | null> {
  const lines: string[] = [];
  let partial = "";
  let ended = false;
  let listening = false;
  let pending: ((line: string | null) => void) | undefined;

  const settle = () => {
    if (pending === undefined) return;
    const line = lines.shift();
    if (line === undefined && !ended) return;
    const resolve = pending;
    pending = undefined;
    input.pause();
    resolve(line ?? null);
  };

  const listen = () => {
    listening = true;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      lines.push(...parts);
      settle();
    });
    input.on("end", () => {
      ended = true;
      if (partial !== "") lines.push(partial);
      partial = "";
      settle();
    });
  };

  return () =>
    new Promise((resolve) => {
      pending = resolve;
      if (!listening) listen();
      settle();
      if (pending !== undefined) input.resume();
    });
}
