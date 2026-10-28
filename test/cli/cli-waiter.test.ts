import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CliWaiter, stdinLines } from "../../src/cli/cli-waiter.js";
import type { WaitRequest } from "../../src/ports/waiter.js";

const gate: WaitRequest = { nodeId: "g1", kind: "gate", shown: "Check the plan" };
const hardstop: WaitRequest = {
  nodeId: "h1",
  kind: "hardstop",
  shown: "Check tests",
  condition: "tests fail",
};
const ask: WaitRequest = {
  nodeId: "q1",
  kind: "ask",
  question: "Pick a colour",
  options: ["red", "blue", "green"],
};
const freeAsk: WaitRequest = { nodeId: "q2", kind: "ask", question: "Why?", options: [] };

const gatePrompt = "approve, or reject <reason>: ";
const hardstopPrompt = "continue, or stop <reason>: ";
const askPrompt = "answer (number or label): ";

function scripted(lines: (string | null)[]) {
  const queue = [...lines];
  let reads = 0;
  const written: string[] = [];
  const waiter = new CliWaiter({
    readLine: async () => {
      reads++;
      if (queue.length === 0) throw new Error("read past the scripted lines");
      return queue.shift() ?? null;
    },
    write: (text) => written.push(text),
  });
  return { waiter, output: () => written.join(""), reads: () => reads };
}

describe("CliWaiter", () => {
  describe("gate", () => {
    it("prints the shown text and the reply prompt", async () => {
      const { waiter, output } = scripted(["approve"]);

      await waiter.wait(gate);

      expect(output()).toBe(`g1 gate: Check the plan\n${gatePrompt}`);
    });

    it.each([
      ["approve", { decision: "approve" }],
      ["  approve  ", { decision: "approve" }],
      ["reject wrong scope", { decision: "reject", reason: "wrong scope" }],
      ["reject", { decision: "reject", reason: "" }],
    ])("reads %j", async (line, reply) => {
      expect(await scripted([line]).waiter.wait(gate)).toEqual(reply);
    });

    it.each(["rejected", "maybe", "approved", ""])("re-asks after %j", async (line) => {
      const { waiter, output, reads } = scripted([line, "approve"]);

      expect(await waiter.wait(gate)).toEqual({ decision: "approve" });
      expect(reads()).toBe(2);
      expect(output()).toBe(
        `g1 gate: Check the plan\n${gatePrompt}not understood: ${line}\n${gatePrompt}`,
      );
    });
  });

  describe("hard stop", () => {
    it("prints the shown text, the condition and the reply prompt", async () => {
      const { waiter, output } = scripted(["continue"]);

      await waiter.wait(hardstop);

      expect(output()).toBe(`h1 hard stop: Check tests\ncondition: tests fail\n${hardstopPrompt}`);
    });

    it.each([
      ["continue", { decision: "continue" }],
      ["stop tests fail", { decision: "stop", reason: "tests fail" }],
      ["stop", { decision: "stop", reason: "" }],
    ])("reads %j", async (line, reply) => {
      expect(await scripted([line]).waiter.wait(hardstop)).toEqual(reply);
    });

    it("re-asks after an approve", async () => {
      const { waiter, reads } = scripted(["approve", "continue"]);

      expect(await waiter.wait(hardstop)).toEqual({ decision: "continue" });
      expect(reads()).toBe(2);
    });
  });

  describe("ask with options", () => {
    it("prints the question and numbered options", async () => {
      const { waiter, output } = scripted(["1"]);

      await waiter.wait(ask);

      expect(output()).toBe(
        `q1 asks: Pick a colour\n  1. red\n  2. blue\n  3. green\n${askPrompt}`,
      );
    });

    it.each(["2", "blue", " 2 "])("reads %j as blue", async (line) => {
      expect(await scripted([line]).waiter.wait(ask)).toEqual({
        decision: "answer",
        answer: "blue",
      });
    });

    it.each(["0", "4", "Blue", "", "1.5"])("re-asks after %j", async (line) => {
      const { waiter, reads, output } = scripted([line, "3"]);

      expect(await waiter.wait(ask)).toEqual({ decision: "answer", answer: "green" });
      expect(reads()).toBe(2);
      expect(output().endsWith(`not understood: ${line}\n${askPrompt}`)).toBe(true);
    });
  });

  describe("ask without options", () => {
    it("prints the question and a plain reply prompt", async () => {
      const { waiter, output } = scripted(["because"]);

      await waiter.wait(freeAsk);

      expect(output()).toBe("q2 asks: Why?\nanswer: ");
    });

    it("reads any text", async () => {
      expect(await scripted(["any text"]).waiter.wait(freeAsk)).toEqual({
        decision: "answer",
        answer: "any text",
      });
    });

    it("re-asks after an empty line", async () => {
      const { waiter, reads } = scripted(["  ", "any text"]);

      expect(await waiter.wait(freeAsk)).toEqual({ decision: "answer", answer: "any text" });
      expect(reads()).toBe(2);
    });
  });

  describe("end of input", () => {
    it.each([gate, hardstop, ask, freeAsk])(
      "returns closed on the first read ($kind)",
      async (request) => {
        const { waiter, reads } = scripted([null]);

        expect(await waiter.wait(request)).toEqual({ decision: "closed" });
        expect(reads()).toBe(1);
      },
    );

    it.each([gate, hardstop, ask, freeAsk])(
      "returns closed after an invalid line ($kind)",
      async (request) => {
        const { waiter, reads } = scripted(["", null]);

        expect(await waiter.wait(request)).toEqual({ decision: "closed" });
        expect(reads()).toBe(2);
      },
    );
  });
});

describe("stdinLines", () => {
  it("keeps the second line of a chunk for the next read", async () => {
    const input = new PassThrough();
    const readLine = stdinLines(input);
    input.write("approve\n2\n");

    expect(await readLine()).toBe("approve");
    expect(await readLine()).toBe("2");
  });

  it("joins a line split across chunks", async () => {
    const input = new PassThrough();
    const readLine = stdinLines(input);

    const line = readLine();
    input.write("appr");
    input.write("ove\n");

    expect(await line).toBe("approve");
  });

  it("returns null once the input ends with nothing buffered", async () => {
    const input = new PassThrough();
    const readLine = stdinLines(input);
    input.end("approve\n");

    expect(await readLine()).toBe("approve");
    expect(await readLine()).toBeNull();
  });

  it("pauses the input after a read", async () => {
    const input = new PassThrough();
    const readLine = stdinLines(input);
    input.write("approve\n");

    await readLine();

    expect(input.isPaused()).toBe(true);
  });

  it("neither takes over SIGINT nor sets raw mode while a read is pending", async () => {
    const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const readLine = stdinLines(input);
    const before = process.listenerCount("SIGINT");

    const line = readLine();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(input.setRawMode).not.toHaveBeenCalled();
    input.write("approve\n");
    expect(await line).toBe("approve");
  });
});
