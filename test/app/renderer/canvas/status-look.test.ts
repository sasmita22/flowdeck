import { describe, expect, it } from "vitest";
import { statusBadge } from "../../../../src/app/renderer/canvas/status-look.js";
import type { DisplayStatus } from "../../../../src/core/run/display.js";

const statuses: DisplayStatus[] = ["waiting", "running", "needs you", "failed", "done"];

describe("statusBadge", () => {
  it.each(statuses)("labels %s with its status text and a colour", (status) => {
    const badge = statusBadge(status);

    expect(badge.label).toBe(status);
    expect(badge.color).toMatch(/\S/);
  });

  it("gives each of the five statuses its own colour", () => {
    const colors = statuses.map((status) => statusBadge(status).color);

    expect(new Set(colors).size).toBe(5);
  });
});
