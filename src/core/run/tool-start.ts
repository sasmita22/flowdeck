export type ToolStarts = {
  onToolStart(
    sessionId: string,
    handler: (payload: Record<string, unknown>) => Promise<void>,
  ): () => void;
};
