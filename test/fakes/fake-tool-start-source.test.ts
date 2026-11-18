import { describe, expect, it, vi } from "vitest";
import { FakeToolStartSource } from "./fake-tool-start-source.js";

const payload = { tool_name: "Bash", tool_input: { command: "git -C /other status" } };

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const settledWithin = (promise: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

describe("FakeToolStartSource", () => {
  it("hands the payload to its session's handler and settles when the handler does", async () => {
    const source = new FakeToolStartSource();
    const held = gate();
    const handler = vi.fn(() => held.promise);
    source.onToolStart("s1", handler);

    const started = source.start("s1", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    expect(await settledWithin(started, 20)).toBe(false);
    held.open();
    expect(await settledWithin(started, 20)).toBe(true);
  });

  it("settles at once when no handler listens", async () => {
    const source = new FakeToolStartSource();

    expect(await settledWithin(source.start("s1", payload), 20)).toBe(true);
  });

  it("does not call the handler of another session", async () => {
    const source = new FakeToolStartSource();
    const handler = vi.fn(async () => {});
    source.onToolStart("s2", handler);

    await source.start("s1", payload);

    expect(handler).not.toHaveBeenCalled();
  });

  it("stops calling a handler once it unsubscribed", async () => {
    const source = new FakeToolStartSource();
    const handler = vi.fn(async () => {});
    const unsubscribe = source.onToolStart("s1", handler);

    unsubscribe();
    await source.start("s1", payload);

    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a newer handler in place when an older one unsubscribes", async () => {
    const source = new FakeToolStartSource();
    const older = vi.fn(async () => {});
    const newer = vi.fn(async () => {});
    const unsubscribeOlder = source.onToolStart("s1", older);
    source.onToolStart("s1", newer);

    unsubscribeOlder();
    await source.start("s1", payload);

    expect(newer).toHaveBeenCalledWith(payload);
    expect(older).not.toHaveBeenCalled();
  });
});
