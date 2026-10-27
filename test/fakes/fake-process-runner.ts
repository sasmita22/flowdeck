import type { ProcessResult, ProcessRunner } from "../../src/ports/process-runner.js";

export type ProcessCall = { command: string; args: readonly string[]; cwd: string };

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessCall[] = [];
  private readonly results: (ProcessResult | Error)[];

  constructor(results: (ProcessResult | Error)[]) {
    this.results = [...results];
  }

  async run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args], cwd });
    const result = this.results[this.calls.length - 1];
    if (result === undefined) {
      throw new Error(
        `FakeProcessRunner has no result scripted for call ${this.calls.length} ("${command}")`,
      );
    }
    if (result instanceof Error) throw result;
    return result;
  }
}
