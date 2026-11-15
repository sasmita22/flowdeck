import type { RunNarration, RunNarrator } from "../../src/ports/run-narrator.js";

const abortError = () =>
  Object.assign(new Error("The narration was aborted"), { name: "AbortError" });

export class FakeRunNarrator implements RunNarrator {
  readonly calls: string[] = [];
  private failure: unknown;
  private failing = false;
  private held: Promise<void> | undefined;

  constructor(private readonly narration: RunNarration) {}

  failWith(error: unknown): void {
    this.failure = error;
    this.failing = true;
  }

  hold(): () => void {
    let release = () => {};
    this.held = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  async narrate(digest: string, signal: AbortSignal): Promise<RunNarration> {
    this.calls.push(digest);
    if (this.failing) {
      this.failing = false;
      throw this.failure;
    }
    const held = this.held;
    if (held !== undefined) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(abortError());
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        void held.then(resolve);
      });
    }
    return { ...this.narration };
  }
}
