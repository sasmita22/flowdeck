import { describe, expect, it } from "vitest";
import * as hardstop from "../../../../src/core/nodes/hardstop/execute.js";
import { hardstopOutcome, hardstopRequest } from "../../../../src/core/nodes/hardstop/execute.js";
import type { WaitReply } from "../../../../src/core/run/wait.js";

const base = { condition: "tests fail", shown: "Check tests", locked: true, enabled: true };
const request = { nodeId: "h1", kind: "hardstop", shown: "Check tests", condition: "tests fail" };

describe("hardstopRequest", () => {
  it("asks with the shown and condition text", () => {
    expect(hardstopRequest("h1", base)).toEqual(request);
  });

  it.each([{ locked: false }, { enabled: false }, { locked: false, enabled: false }])(
    "asks the same way whatever %o says",
    (fields) => {
      expect(hardstopRequest("h1", { ...base, ...fields })).toEqual(request);
    },
  );

  it("exports no way to skip a hard stop", () => {
    expect(Object.keys(hardstop).sort()).toEqual([
      "hardstopCheckTurn",
      "hardstopOutcome",
      "hardstopRequest",
      "noVerdictRequest",
    ]);
  });
});

describe("hardstopOutcome", () => {
  it("continue is done with the line continued", () => {
    expect(hardstopOutcome("h1", { decision: "continue" })).toEqual({
      status: "done",
      line: "continued",
      decision: { nodeId: "h1", decision: "continued" },
    });
  });

  it("stop with a reason fails with the reason", () => {
    expect(hardstopOutcome("h1", { decision: "stop", reason: "tests fail" })).toEqual({
      status: "failed",
      reason: "stopped: tests fail",
      decision: { nodeId: "h1", decision: "stopped", reason: "tests fail" },
    });
  });

  it("stop with an empty reason fails with stopped alone", () => {
    expect(hardstopOutcome("h1", { decision: "stop", reason: "" })).toEqual({
      status: "failed",
      reason: "stopped",
      decision: { nodeId: "h1", decision: "stopped", reason: "" },
    });
  });

  it("closed input fails with no decision", () => {
    expect(hardstopOutcome("h1", { decision: "closed" })).toEqual({
      status: "failed",
      reason: "no answer: input closed",
    });
  });

  it.each<WaitReply>([{ decision: "approve" }, { decision: "reject", reason: "r" }])(
    "fails on a reply not meant for a hard stop: $decision",
    (reply) => {
      expect(hardstopOutcome("h1", reply)).toEqual({
        status: "failed",
        reason: `unexpected reply: ${reply.decision}`,
      });
    },
  );

  it("takes continue or stop as the answer to an unreadable verdict, and refuses any other", () => {
    const answer = (text: string) => hardstopOutcome("h1", { decision: "answer", answer: text });
    const decision = (text: string) => ({ nodeId: "h1", decision: "answered", answer: text });

    expect(answer("continue")).toEqual({
      status: "done",
      line: "answered: continue",
      decision: decision("continue"),
    });
    expect(answer("stop")).toEqual({
      status: "failed",
      reason: "stopped: no readable verdict",
      decision: decision("stop"),
    });
    expect(answer("x")).toEqual({ status: "failed", reason: "unexpected answer: x" });
  });
});
