export type ProcessResult = { code: number | null; stdout: string; stderr: string };

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult>;
}
