import { describe, expect, it } from "vitest";
import { stopMarker, stoppedNodeOf } from "../../../src/core/run/stop-marker.js";

describe("stopMarker", () => {
  it("names the node the session stopped at", () => {
    expect(stopMarker("h")).toBe("STOPPED NODE h");
  });
});

describe("stoppedNodeOf", () => {
  it("reads the node from a reply whose last line is the marker", () => {
    expect(stoppedNodeOf("The tests fail.\nSTOPPED NODE android-h")).toBe("android-h");
  });

  it("reads the marker past trailing blank lines", () => {
    expect(stoppedNodeOf("Stopping.\n\nSTOPPED NODE android-h\n  \n")).toBe("android-h");
  });

  it("reads the marker when the reply wraps it in backticks, as the step line shows it", () => {
    expect(stoppedNodeOf("The tests fail.\n`STOPPED NODE android-h`")).toBe("android-h");
  });

  it("reads back what stopMarker writes", () => {
    expect(stoppedNodeOf(`done\n${stopMarker("android-loop")}`)).toBe("android-loop");
  });

  it.each([
    { name: "no message", message: undefined },
    { name: "an empty message", message: "" },
    { name: "a reply with no marker", message: "all done" },
    { name: "a marker that is not the last line", message: "STOPPED NODE android-h\nthen more" },
    { name: "a marker inside a sentence", message: "I will print STOPPED NODE android-h" },
    { name: "a marker with words after the id", message: "STOPPED NODE android-h now" },
    { name: "a marker with no id", message: "STOPPED NODE " },
  ])("reads nothing from $name", ({ message }) => {
    expect(stoppedNodeOf(message)).toBeUndefined();
  });
});
