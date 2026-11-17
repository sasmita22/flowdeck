import { describe, expect, it } from "vitest";
import { issueSummary, statusBadge } from "../../../../src/app/renderer/canvas/status-look.js";
import type { DisplayStatus } from "../../../../src/core/run/display.js";

const statuses: DisplayStatus[] = [
  "waiting",
  "sent",
  "running",
  "needs you",
  "failed",
  "done",
  "skipped",
];

const everyStatus: DisplayStatus[] = [...statuses, "stopped"];

describe("statusBadge", () => {
  it.each(statuses)("labels %s with its status text and a colour", (status) => {
    const badge = statusBadge(status);

    expect(badge.label).toBe(status);
    expect(badge.color).toMatch(/\S/);
  });

  it("gives each of the eight statuses its own colour", () => {
    const colors = everyStatus.map((status) => statusBadge(status).color);

    expect(new Set(colors.filter(Boolean)).size).toBe(8);
  });

  it("labels stopped as stopped, in a colour apart from needs you", () => {
    expect(statusBadge("stopped").label).toBe("stopped");
    expect(statusBadge("stopped").color).toMatch(/\S/);
    expect(statusBadge("stopped").color).not.toBe(statusBadge("needs you").color);
  });
});

describe("issueSummary", () => {
  it("shows a node's one problem as it is", () => {
    expect(issueSummary(["Write the command to run."])).toEqual({
      text: "Write the command to run.",
      title: "Write the command to run.",
    });
  });

  it("counts several problems and lists them all on hover", () => {
    expect(issueSummary(["Write the command to run.", "Has no input."])).toEqual({
      text: "2 problems",
      title: "Write the command to run.\nHas no input.",
    });
  });
});
