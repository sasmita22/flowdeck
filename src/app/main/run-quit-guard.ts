export type RunQuitGuardOptions = {
  goingRuns: () => Promise<string[]>;
  stopGoingRuns: () => Promise<unknown>;
  requestDialog: () => void;
  closeWindow: () => void;
  cancelled: () => void;
};

export type RunQuitGuard = {
  onClose(event: { preventDefault(): void; defaultPrevented: boolean }): void;
  answer(answer: "keep" | "stop" | "cancel"): void;
  reset(): void;
};

export function createRunQuitGuard(options: RunQuitGuardOptions): RunQuitGuard {
  let pending = false;
  let confirmed = false;
  let stopping = false;

  const close = () => {
    confirmed = true;
    options.closeWindow();
  };

  const ask = async () => {
    const going = await options.goingRuns().catch(() => []);
    if (going.length === 0) close();
    else options.requestDialog();
  };

  const stopThenClose = async () => {
    await options.stopGoingRuns().catch(() => undefined);
    close();
  };

  return {
    onClose(event) {
      if (confirmed || event.defaultPrevented) return;
      event.preventDefault();
      if (pending) return;
      pending = true;
      void ask();
    },
    answer(answer) {
      if (!pending || stopping) return;
      if (answer === "keep") close();
      else if (answer === "stop") {
        stopping = true;
        void stopThenClose();
      } else {
        pending = false;
        options.cancelled();
      }
    },
    reset() {
      if (!stopping) pending = false;
    },
  };
}
