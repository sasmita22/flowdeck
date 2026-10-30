import type { Readable } from "node:stream";
import { usd } from "../core/run/budget.js";
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

function permissionQuestion(nodeId: string, tool: string, input: string): Question {
  return {
    ...gateQuestion(nodeId, ""),
    header: `${nodeId} permission: Allow ${tool}: ${input}?\n`,
  };
}

function budgetQuestion(
  nodeId: string,
  spend: number,
  budget: number,
  unconfirmed: boolean,
): Question {
  const state = unconfirmed
    ? `Spend not confirmed yet: last read ${usd(spend)} of ${usd(budget)}`
    : `Budget reached: spent ${usd(spend)} of ${usd(budget)}`;
  return {
    header: `${nodeId} paused. ${state}\n`,
    prompt: `a new budget above ${usd(spend)}, or stop <reason>: `,
    parse: (line) => {
      const raised = Number(line);
      if (/^\d+(\.\d+)?$/.test(line) && raised > spend)
        return { decision: "raise", budget: raised };
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
    case "permission":
      return permissionQuestion(request.nodeId, request.tool, request.input);
    case "budget":
      return budgetQuestion(
        request.nodeId,
        request.spend,
        request.budget,
        request.unconfirmed === true,
      );
  }
}

export class CliWaiter implements Waiter {
  private turn: Promise<unknown> = Promise.resolve();

  constructor(private readonly io: CliWaiterIo) {}

  wait(request: WaitRequest, signal?: AbortSignal): Promise<WaitReply> {
    const reply = this.turn.then(() => this.ask(request, signal));
    this.turn = reply;
    return reply;
  }

  private async ask(request: WaitRequest, signal?: AbortSignal): Promise<WaitReply> {
    if (signal?.aborted) return { decision: "closed" };
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
