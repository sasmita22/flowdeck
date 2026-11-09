import { describe, expect, it } from "vitest";
import { expectPaneToShow } from "./pane-text.js";

const beforeRepaint = "▐▛███▜▌ Claude Code\n\n⏺ OK\n";
const afterRepaint = `${beforeRepaint}\n> fdterm\n`;

describe("expectPaneToShow", () => {
  it("waits for text that the pane shows only after a repaint", async () => {
    let calls = 0;
    const capture = async () => (++calls === 1 ? beforeRepaint : afterRepaint);

    await expectPaneToShow(capture, "fdterm");
  });

  it("fails when the pane never shows the text", async () => {
    const capture = async () => beforeRepaint;

    await expect(expectPaneToShow(capture, "fdterm", 200)).rejects.toThrow();
  });
});
