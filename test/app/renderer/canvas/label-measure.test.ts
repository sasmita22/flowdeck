import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { containerText, labelX, nodeWidth } from "../../../../src/app/renderer/canvas/frames.js";
import { nodeOutline } from "../../../../src/app/renderer/nodes/outlines.js";

const long = "Review every changed file against the plan and list each gap";

const theme: Record<string, string> = {
  "--f-body": ' "Instrument Sans", sans-serif',
  "--f-mono": " Menlo, monospace",
};

const measured: string[] = [];

const context = {
  font: "",
  measureText(text: string) {
    measured.push(`${this.font}|${text}`);
    return { width: text.length * 10 + 0.25 };
  },
};

beforeAll(() => {
  vi.stubGlobal("document", {
    documentElement: {},
    createElement: () => ({ getContext: () => context }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => theme[name] ?? "",
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  measured.length = 0;
});

describe("label width measured with the drawn font", () => {
  it("sizes an Agent by its label's rendered width in the body font", () => {
    const { padL } = nodeOutline("agent");
    expect(nodeWidth({ type: "agent", label: long })).toBe(labelX("agent") + 601 + padL);
    expect(measured).toContain(`600 13px "Instrument Sans", sans-serif|${long}`);
  });

  it("sizes a Script by its label's rendered width in the mono font", () => {
    const { padL } = nodeOutline("script");
    expect(nodeWidth({ type: "script", label: long })).toBe(labelX("script") + 601 + padL);
    expect(measured).toContain(`600 12px Menlo, monospace|${long}`);
  });

  it("measures the same font and text once", () => {
    const label = "Plan the next sprint and its review steps";
    nodeWidth({ type: "agent", label });
    nodeWidth({ type: "agent", label });
    expect(measured.filter((entry) => entry.endsWith(`|${label}`))).toHaveLength(1);
  });

  it("keeps a short label at its type's base width", () => {
    expect(nodeWidth({ type: "agent", label: "agent" })).toBe(170);
  });

  it("falls back to the character estimate while the theme font is unset", () => {
    const label = "A label measured before the theme loads";
    const body = theme["--f-body"];
    theme["--f-body"] = "";
    try {
      const { padL } = nodeOutline("agent");
      expect(nodeWidth({ type: "agent", label })).toBe(labelX("agent") + label.length * 7 + padL);
    } finally {
      theme["--f-body"] = body ?? "";
    }
    expect(nodeWidth({ type: "agent", label })).toBe(
      labelX("agent") + label.length * 10 + 1 + nodeOutline("agent").padL,
    );
  });
  it("sizes a Loop by its title's rendered width in the mono title font plus its letter spacing", () => {
    const text = containerText("loop", long, "max 3");
    const titleWidth = text.length * 10 + 1;
    expect(nodeWidth({ type: "loop", label: long, sub: "max 3" })).toBeCloseTo(
      titleWidth + text.length * 0.44 + 2 * nodeOutline("loop").padL,
      6,
    );
    expect(measured).toContain(`600 11px Menlo, monospace|${text}`);
  });
});
