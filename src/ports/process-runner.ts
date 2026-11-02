export type ProcessResult = { code: number | null; stdout: string; stderr: string };

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    job?: string,
  ): Promise<ProcessResult>;
  rejoin?(job: string, signal?: AbortSignal): Promise<ProcessResult | undefined>;
}
