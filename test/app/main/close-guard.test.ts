import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createCloseGuard } from "../../../src/app/main/close-guard.js";

const closeEvent = () => ({ preventDefault: vi.fn() });

describe("createCloseGuard", () => {
  let requestClose: Mock<() => void>;
  let closeWindow: Mock<() => void>;
  let guard: ReturnType<typeof createCloseGuard>;

  beforeEach(() => {
    requestClose = vi.fn<() => void>();
    closeWindow = vi.fn<() => void>();
    guard = createCloseGuard({ requestClose, closeWindow });
  });

  it("lets a clean window close without asking the renderer", () => {
    const event = closeEvent();

    guard.onClose(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestClose).not.toHaveBeenCalled();
  });

  it("stops a dirty window closing and asks the renderer once", () => {
    const event = closeEvent();
    guard.setDirty(true);

    guard.onClose(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("stops a second close while a request is pending without asking again", () => {
    guard.setDirty(true);
    guard.onClose(closeEvent());
    const second = closeEvent();

    guard.onClose(second);

    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("asks again on the next close after the renderer cancels", () => {
    guard.setDirty(true);
    guard.onClose(closeEvent());
    guard.answer("cancel");
    const next = closeEvent();

    guard.onClose(next);

    expect(closeWindow).not.toHaveBeenCalled();
    expect(next.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestClose).toHaveBeenCalledTimes(2);
  });

  it("closes the window on a close answer and lets that close through without asking again", () => {
    guard.setDirty(true);
    guard.onClose(closeEvent());

    guard.answer("close");
    const confirmed = closeEvent();
    guard.onClose(confirmed);

    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(confirmed.preventDefault).not.toHaveBeenCalled();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("after reset a dirty-pending guard lets the close through", () => {
    guard.setDirty(true);
    guard.onClose(closeEvent());

    guard.reset();
    const event = closeEvent();
    guard.onClose(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("after reset a pending request does not stop the next dirty close from asking again", () => {
    guard.setDirty(true);
    guard.onClose(closeEvent());
    guard.reset();
    guard.setDirty(true);
    const event = closeEvent();

    guard.onClose(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(requestClose).toHaveBeenCalledTimes(2);
  });

  it("lets the window close once the renderer reports clean again", () => {
    guard.setDirty(true);
    guard.setDirty(false);
    const event = closeEvent();

    guard.onClose(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(requestClose).not.toHaveBeenCalled();
  });
});
