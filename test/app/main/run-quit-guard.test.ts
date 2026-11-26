import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createRunQuitGuard } from "../../../src/app/main/run-quit-guard.js";

const closeEvent = (defaultPrevented = false) => {
  const event = {
    defaultPrevented,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createRunQuitGuard", () => {
  let going: string[];
  let goingRuns: Mock<() => Promise<string[]>>;
  let stopGoingRuns: Mock<() => Promise<unknown>>;
  let requestDialog: Mock<() => void>;
  let closeWindow: Mock<() => void>;
  let cancelled: Mock<() => void>;
  let guard: ReturnType<typeof createRunQuitGuard>;

  const build = () =>
    createRunQuitGuard({ goingRuns, stopGoingRuns, requestDialog, closeWindow, cancelled });

  beforeEach(() => {
    going = ["run-1"];
    goingRuns = vi.fn(async () => going);
    stopGoingRuns = vi.fn(async () => undefined);
    requestDialog = vi.fn<() => void>();
    closeWindow = vi.fn<() => void>();
    cancelled = vi.fn<() => void>();
    guard = build();
  });

  const asked = async () => {
    guard.onClose(closeEvent());
    await settle();
  };

  it("holds a close while runs are going and asks the renderer for the dialog once", async () => {
    const event = closeEvent();

    guard.onClose(event);
    await settle();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestDialog).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("holds a close with no run going only while the engine answers, then closes with no dialog and lets that close through", async () => {
    going = [];
    const event = closeEvent();

    guard.onClose(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await settle();

    expect(requestDialog).not.toHaveBeenCalled();
    expect(closeWindow).toHaveBeenCalledTimes(1);
    const resumed = closeEvent();
    guard.onClose(resumed);
    expect(resumed.preventDefault).not.toHaveBeenCalled();
    expect(goingRuns).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a close another listener already held", async () => {
    const event = closeEvent(true);

    guard.onClose(event);
    await settle();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(goingRuns).not.toHaveBeenCalled();
    expect(requestDialog).not.toHaveBeenCalled();
  });

  it("holds a second close while the first is pending without asking the engine or the renderer again", async () => {
    guard.onClose(closeEvent());
    const whileQuerying = closeEvent();
    guard.onClose(whileQuerying);
    await settle();
    const whileAsking = closeEvent();
    guard.onClose(whileAsking);
    await settle();

    expect(whileQuerying.preventDefault).toHaveBeenCalledTimes(1);
    expect(whileAsking.preventDefault).toHaveBeenCalledTimes(1);
    expect(goingRuns).toHaveBeenCalledTimes(1);
    expect(requestDialog).toHaveBeenCalledTimes(1);
  });

  it("closes the window on keep without stopping anything, and lets that close through", async () => {
    await asked();

    guard.answer("keep");
    const resumed = closeEvent();
    guard.onClose(resumed);
    await settle();

    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(stopGoingRuns).not.toHaveBeenCalled();
    expect(resumed.preventDefault).not.toHaveBeenCalled();
  });

  it("stops the going runs once on stop and closes the window only after they are stopped", async () => {
    let finish = () => {};
    stopGoingRuns.mockImplementation(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
    );
    await asked();

    guard.answer("stop");
    await settle();
    expect(stopGoingRuns).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
    finish();
    await settle();

    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(stopGoingRuns).toHaveBeenCalledTimes(1);
  });

  it("on cancel stops nothing, keeps the window open, reports the cancel, and asks the engine again on the next close", async () => {
    await asked();

    guard.answer("cancel");
    const next = closeEvent();
    guard.onClose(next);
    await settle();

    expect(stopGoingRuns).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(next.preventDefault).toHaveBeenCalledTimes(1);
    expect(goingRuns).toHaveBeenCalledTimes(2);
    expect(requestDialog).toHaveBeenCalledTimes(2);
  });

  it("closes the window with no dialog when the engine cannot say which runs are going", async () => {
    goingRuns.mockRejectedValue(new Error("engine gone"));

    guard.onClose(closeEvent());
    await settle();

    expect(requestDialog).not.toHaveBeenCalled();
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("still closes the window when stopping the runs fails", async () => {
    stopGoingRuns.mockRejectedValue(new Error("timed out"));
    await asked();

    guard.answer("stop");
    await settle();

    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  const stopHeld = () => {
    let finish = () => {};
    stopGoingRuns.mockImplementation(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
    );
    return () => finish();
  };

  it("after a reset while the dialog is pending, holds the next close and asks the engine and the renderer again", async () => {
    await asked();

    guard.reset();
    const next = closeEvent();
    guard.onClose(next);
    await settle();

    expect(next.preventDefault).toHaveBeenCalledTimes(1);
    expect(goingRuns).toHaveBeenCalledTimes(2);
    expect(requestDialog).toHaveBeenCalledTimes(2);
  });

  it("a reset while the runs are stopping still closes the window once they are stopped, without asking again", async () => {
    const finish = stopHeld();
    await asked();

    guard.answer("stop");
    guard.reset();
    guard.onClose(closeEvent());
    await settle();
    finish();
    await settle();

    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(goingRuns).toHaveBeenCalledTimes(1);
    expect(requestDialog).toHaveBeenCalledTimes(1);
  });

  it("ignores further answers while the runs are stopping, and still closes once they are stopped", async () => {
    const finish = stopHeld();
    await asked();

    guard.answer("stop");
    guard.answer("stop");
    guard.answer("cancel");
    await settle();
    finish();
    await settle();

    expect(stopGoingRuns).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer when nothing is pending", async () => {
    guard.answer("keep");
    guard.answer("stop");
    guard.answer("cancel");
    await settle();

    expect(closeWindow).not.toHaveBeenCalled();
    expect(stopGoingRuns).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
