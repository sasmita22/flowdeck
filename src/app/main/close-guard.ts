export type CloseGuardOptions = { requestClose: () => void; closeWindow: () => void };

export type CloseGuard = {
  setDirty(dirty: boolean): void;
  onClose(event: { preventDefault(): void }): void;
  answer(answer: "close" | "cancel"): void;
  reset(): void;
};

export function createCloseGuard(options: CloseGuardOptions): CloseGuard {
  let dirty = false;
  let pending = false;
  let confirmed = false;

  return {
    setDirty(next) {
      dirty = next;
    },
    onClose(event) {
      if (confirmed || !dirty) return;
      event.preventDefault();
      if (pending) return;
      pending = true;
      options.requestClose();
    },
    answer(answer) {
      pending = false;
      if (answer === "cancel") return;
      confirmed = true;
      options.closeWindow();
    },
    reset() {
      dirty = false;
      pending = false;
    },
  };
}
