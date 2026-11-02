import type { ProcessResult, ProcessRunner } from "../../src/ports/process-runner.js";

export type ProcessCall = { command: string; args: readonly string[]; cwd: string; job?: string };

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessCall[] = [];
  readonly rejoins: string[] = [];
  private readonly results: (ProcessResult | Error)[];
  private readonly rejoined = new Map<string, ProcessResult>();

  constructor(results: (ProcessResult | Error)[]) {
    this.results = [...results];
  }

  async run(
    command: string,
    args: readonly string[],
    cwd: string,
    _signal?: AbortSignal,
    job?: string,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args], cwd, ...(job === undefined ? {} : { job }) });
    const result = this.results[this.calls.length - 1];
    if (result === undefined) {
      throw new Error(
        `FakeProcessRunner has no result scripted for call ${this.calls.length} ("${command}")`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }

  finishes(job: string, result: ProcessResult): void {
    this.rejoined.set(job, result);
  }

  async rejoin(job: string): Promise<ProcessResult | undefined> {
    this.rejoins.push(job);
    return this.rejoined.get(job);
  }
}
