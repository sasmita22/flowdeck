import { describe, expect, it } from "vitest";
import { FakeRunNarrator } from "./fake-run-narrator.js";

const signal = () => new AbortController().signal;

describe("FakeRunNarrator", () => {
  it("returns the configured text and cost and records each call's digest", async () => {
    const narrator = new FakeRunNarrator({ text: "The run failed at verify.", cost: 0.002 });

    await expect(narrator.narrate("digest one", signal())).resolves.toEqual({
      text: "The run failed at verify.",
      cost: 0.002,
    });
    await narrator.narrate("digest two", signal());

    expect(narrator.calls).toEqual(["digest one", "digest two"]);
  });

  it("rejects the next call with the error given to failWith, then answers again", async () => {
    const narrator = new FakeRunNarrator({ text: "ok", cost: 0 });
    const error = new Error("claude is not logged in");

    narrator.failWith(error);

    await expect(narrator.narrate("first", signal())).rejects.toBe(error);
    await expect(narrator.narrate("second", signal())).resolves.toEqual({ text: "ok", cost: 0 });
    expect(narrator.calls).toEqual(["first", "second"]);
  });

  it("keeps a held call pending until release", async () => {
    const narrator = new FakeRunNarrator({ text: "late", cost: 0.01 });
    const release = narrator.hold();
    let settled = false;

    const pending = narrator.narrate("held", signal()).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false);
    expect(narrator.calls).toEqual(["held"]);

    release();

    await expect(pending).resolves.toEqual({ text: "late", cost: 0.01 });
  });

  it("rejects a held call with an abort error when its signal aborts", async () => {
    const narrator = new FakeRunNarrator({ text: "never", cost: 0 });
    narrator.hold();
    const controller = new AbortController();

    const pending = narrator.narrate("held", controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
